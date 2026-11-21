/**
 * F-08 — one Redis pattern subscription (`ui:*`) per API instance, fanned out to the WebSocket
 * connections of that org. Each connection only receives what its user may see (same rules as
 * GET /alerts): admins everything; others alerts of their teams or alerts they were notified about.
 * Instances are independent, so any number of API replicas can run behind a load balancer.
 */
import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { CONFIG_CHANGED, prom, metrics, UI_CHANNEL_PATTERN, type Redis } from '@alerting/config';
import { ConfigChanged, UiEvent } from '@alerting/contracts';
import { eq, t, type Db } from '@alerting/db';

export interface Conn {
  socket: WebSocket;
  userId: string;
  orgId: string;
  role: 'admin' | 'member';
  teams: Set<string>;
  /** Alerts this user got a delivery for (visible even outside their teams). */
  notified: Set<string>;
}

const ALERT_TEAM_CACHE = 10_000;

let gauges: { connections: prom.Gauge; messages: prom.Counter; dropped: prom.Counter } | undefined;
function meters() {
  gauges ??= {
    connections: new prom.Gauge({
      name: 'ws_connections',
      help: 'Open WebSocket connections',
      registers: [metrics()],
    }),
    messages: new prom.Counter({
      name: 'ws_messages_total',
      help: 'UiEvents sent to browsers',
      labelNames: ['type'],
      registers: [metrics()],
    }),
    dropped: new prom.Counter({
      name: 'ws_invalid_events_total',
      help: 'Messages on ui:* that are not a valid UiEvent',
      registers: [metrics()],
    }),
  };
  return gauges;
}

export class Hub {
  private readonly byOrg = new Map<string, Set<Conn>>();
  /** alertId → teamId, so events that carry only an alertId can be filtered. */
  private readonly alertTeam = new Map<string, string>();
  private sub: Redis | undefined;

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start() {
    meters();
    this.sub = this.redis.duplicate();
    this.sub.on('pmessage', (_p, channel, msg) => void this.onUi(channel, msg));
    this.sub.on('message', (channel, msg) => {
      if (channel === CONFIG_CHANGED) void this.onConfig(msg);
    });
    await this.sub.psubscribe(UI_CHANNEL_PATTERN);
    await this.sub.subscribe(CONFIG_CHANGED);
  }

  async stop() {
    for (const set of this.byOrg.values()) for (const c of set) c.socket.close(1001, 'server shutting down');
    this.sub?.disconnect();
  }

  async teamsOf(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ teamId: t.teamMembers.teamId })
      .from(t.teamMembers)
      .where(eq(t.teamMembers.userId, userId));
    return new Set(rows.map((r) => r.teamId));
  }

  add(c: Conn) {
    const set = this.byOrg.get(c.orgId) ?? new Set();
    set.add(c);
    this.byOrg.set(c.orgId, set);
    meters().connections.inc();
  }

  remove(c: Conn) {
    if (this.byOrg.get(c.orgId)?.delete(c)) meters().connections.dec();
  }

  connections(orgId: string): number {
    return this.byOrg.get(orgId)?.size ?? 0;
  }

  private remember(alertId: string, teamId: string) {
    if (this.alertTeam.size >= ALERT_TEAM_CACHE) this.alertTeam.delete(this.alertTeam.keys().next().value!);
    this.alertTeam.set(alertId, teamId);
  }

  private async teamOfAlert(orgId: string, alertId: string): Promise<string | undefined> {
    const cached = this.alertTeam.get(alertId);
    if (cached) return cached;
    const [row] = await this.db
      .select({ teamId: t.alerts.teamId, orgId: t.alerts.orgId })
      .from(t.alerts)
      .where(eq(t.alerts.id, alertId));
    if (!row || row.orgId !== orgId) return undefined;
    this.remember(alertId, row.teamId);
    return row.teamId;
  }

  private alertIdOf(ev: UiEvent): string | undefined {
    switch (ev.type) {
      case 'alert.created':
        return ev.alert.id;
      case 'alert.updated':
      case 'timeline.appended':
        return ev.alertId;
      case 'delivery.updated':
        return ev.delivery.alertId;
      case 'approval.requested':
        return ev.approval.alertId;
      default:
        return undefined;
    }
  }

  private async onUi(channel: string, msg: string) {
    const orgId = channel.slice('ui:'.length);
    const conns = this.byOrg.get(orgId);
    let json: unknown;
    try {
      json = JSON.parse(msg);
    } catch {
      json = undefined;
    }
    const parsed = UiEvent.safeParse(json);
    if (!parsed.success) {
      meters().dropped.inc();
      this.log.debug({ channel, msg: msg.slice(0, 200) }, 'dropped invalid UiEvent');
      return;
    }
    const ev = parsed.data;
    if (ev.type === 'alert.created') this.remember(ev.alert.id, ev.alert.teamId);
    if (!conns?.size) return;

    const alertId = this.alertIdOf(ev);
    const teamId = alertId ? await this.teamOfAlert(orgId, alertId) : undefined;
    if (alertId && !teamId) return; // unknown alert or another org's
    const data = JSON.stringify(ev);

    for (const c of conns) {
      if (ev.type === 'delivery.updated' && ev.delivery.userId === c.userId)
        c.notified.add(ev.delivery.alertId);
      const visible = !alertId || c.role === 'admin' || c.teams.has(teamId!) || c.notified.has(alertId);
      if (!visible || c.socket.readyState !== c.socket.OPEN) continue;
      c.socket.send(data);
      meters().messages.inc({ type: ev.type });
    }
  }

  /** Team membership changed → refresh the teams of that org's connections. */
  private async onConfig(msg: string) {
    let json: unknown;
    try {
      json = JSON.parse(msg);
    } catch {
      return;
    }
    const parsed = ConfigChanged.safeParse(json);
    if (!parsed.success || parsed.data.kind !== 'teams') return;
    for (const c of this.byOrg.get(parsed.data.orgId) ?? []) c.teams = await this.teamsOf(c.userId);
  }
}
