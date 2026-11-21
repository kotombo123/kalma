import {
  RECENT_EVENTS_MAXLEN,
  recentEventsKey,
  STREAM_ALERTS,
  uiChannel,
  newId,
  type Logger,
  type Redis,
} from '@alerting/config';
import { AlertStreamMessage, NormalizedEvent, UiEvent, type Alert } from '@alerting/contracts';
import { and, eq, inArray, sql, t, type Db } from '@alerting/db';
import type { AlertPort, AlertResolve, AlertUpdate, RecentEventsPort } from './ports.ts';

/** Duplicates for an alert another worker has not committed yet are retried for this long. */
const PENDING_UPDATE_MS = 15_000;

export class DbAlerts implements AlertPort {
  private updates = new Map<string, AlertUpdate & { since: number }>();

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly opts: { validate?: boolean; log?: Logger } = {},
  ) {}

  /**
   * Insert (dispatched_at NULL) → XADD stream:alerts → alert.created. If the process dies
   * between commit and XADD, the notifier's sweeper picks the alert up (dispatched_at IS NULL).
   */
  async create(alerts: Alert[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(t.alerts).values(alerts.map((a) => ({ ...a, escalationLevel: 0 })));
      await tx.insert(t.alertTimeline).values(
        alerts.map((a) => ({
          id: newId(),
          alertId: a.id,
          actorType: 'system' as const,
          kind: 'created' as const,
          data: { ruleId: a.ruleId, ruleVersion: a.ruleVersion, groupKey: a.groupKey },
        })),
      );
    });

    const pipeline = this.redis.pipeline();
    for (const a of alerts) {
      const msg: AlertStreamMessage = {
        alertId: a.id,
        orgId: a.orgId,
        ruleId: a.ruleId,
        ingestTs: a.ingestTs,
      };
      pipeline.xadd(
        STREAM_ALERTS,
        '*',
        'd',
        JSON.stringify(this.opts.validate ? AlertStreamMessage.parse(msg) : msg),
      );
      const ui: UiEvent = { type: 'alert.created', alert: a };
      pipeline.publish(uiChannel(a.orgId), JSON.stringify(this.opts.validate ? UiEvent.parse(ui) : ui));
    }
    await pipeline.exec();
  }

  /**
   * Source said resolved: same effect as "Resolve" in the API (status, resolvedAt, escalation
   * stopped, `resolve` timeline entry, `alert.updated` + `timeline.appended`), actor `system`.
   */
  async resolve(r: AlertResolve): Promise<string | undefined> {
    const entry = {
      id: newId(),
      ts: new Date().toISOString(),
      actorType: 'system' as const,
      kind: 'resolve' as const,
      data: { reason: 'source_resolved', eventId: r.eventId },
    };
    const alertId = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(t.alerts)
        .set({ status: 'resolved', resolvedBy: 'system', resolvedAt: r.resolvedAt, nextEscalationAt: null })
        .where(
          and(
            eq(t.alerts.orgId, r.orgId),
            eq(t.alerts.ruleId, r.ruleId),
            eq(t.alerts.groupKey, r.groupKey),
            inArray(t.alerts.status, ['open', 'acknowledged']),
          ),
        )
        .returning({ id: t.alerts.id });
      if (!row) return undefined;
      await tx.insert(t.alertTimeline).values({ ...entry, alertId: row.id });
      return row.id;
    });
    if (!alertId) return undefined;

    const patch = { status: 'resolved' as const, resolvedBy: 'system', resolvedAt: r.resolvedAt };
    const events: UiEvent[] = [
      { type: 'alert.updated', alertId, patch },
      { type: 'timeline.appended', alertId, entry: { ...entry, alertId } },
    ];
    const pipeline = this.redis.pipeline();
    for (const ui of events) {
      pipeline.publish(uiChannel(r.orgId), JSON.stringify(this.opts.validate ? UiEvent.parse(ui) : ui));
    }
    await pipeline.exec();
    this.opts.log?.info({ alertId, ruleId: r.ruleId }, 'auto-resolved by source');
    return alertId;
  }

  bump(update: AlertUpdate): void {
    const prev = this.updates.get(update.alertId);
    // The dedup count is absolute (from Redis), so the highest one is the truth.
    if (prev && prev.count >= update.count) return;
    this.updates.set(update.alertId, { ...update, since: prev?.since ?? Date.now() });
  }

  /** Every second: `count = GREATEST(count, n)`, then `alert.updated` for each changed alert. */
  async flush(): Promise<void> {
    if (this.updates.size === 0) return;
    const batch = [...this.updates.values()];
    this.updates.clear();

    const done = new Set<string>();
    for (const u of batch) {
      const rows = await this.db
        .update(t.alerts)
        .set({
          count: sql`GREATEST(${t.alerts.count}, ${u.count})`,
          lastSeen: sql`GREATEST(${t.alerts.lastSeen}, ${u.lastSeen}::timestamptz)`,
          lastEvent: u.lastEvent,
        })
        .where(inArray(t.alerts.id, [u.alertId]))
        .returning({ id: t.alerts.id });
      if (rows.length) done.add(u.alertId);
    }

    const pipeline = this.redis.pipeline();
    for (const u of batch) {
      if (done.has(u.alertId)) {
        const ui: UiEvent = {
          type: 'alert.updated',
          alertId: u.alertId,
          patch: { count: u.count, lastSeen: u.lastSeen },
        };
        pipeline.publish(uiChannel(u.orgId), JSON.stringify(ui));
      } else if (Date.now() - u.since < PENDING_UPDATE_MS) {
        // The creating worker has not committed the row yet: retry next flush, keeping the
        // highest count and the oldest timestamp.
        const newer = this.updates.get(u.alertId);
        this.updates.set(u.alertId, newer && newer.count > u.count ? { ...newer, since: u.since } : u);
      } else {
        this.opts.log?.warn({ alertId: u.alertId }, 'dropping count update for unknown alert');
      }
    }
    await pipeline.exec();
  }
}

/** `XADD events:recent:{orgId} MAXLEN ~ 1000 * d <NormalizedEvent JSON>` (format read by the API). */
export function redisRecentEvents(redis: Redis, opts: { validate?: boolean } = {}): RecentEventsPort {
  return {
    async push(events) {
      const pipeline = redis.pipeline();
      for (const e of events) {
        const d = JSON.stringify(opts.validate ? NormalizedEvent.parse(e) : e);
        pipeline.xadd(recentEventsKey(e.orgId), 'MAXLEN', '~', RECENT_EVENTS_MAXLEN, '*', 'd', d);
      }
      await pipeline.exec();
    },
  };
}
