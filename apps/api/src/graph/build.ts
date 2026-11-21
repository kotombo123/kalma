/**
 * Pure assembly of the F-20 graph from the F-09 aggregates (no DB access, unit-testable).
 * Columns: sources → rules → teams → people. Edge weights are alert / notification counts.
 */
import type { GraphEdge, GraphNode, GraphResponse, RuleCount } from '@alerting/contracts';
import type { AlertFlow, EscalationFlow, NotificationFlow, OrgDirectory, PersonTimes } from './queries.ts';

const TOP_RULES = 3;

export interface GraphInput {
  from: string;
  to: string;
  flows: AlertFlow[];
  notifications: NotificationFlow[];
  times: PersonTimes;
  escalations: EscalationFlow[];
  directory: OrgDirectory;
}

interface Acc {
  alerts: number;
  events: number;
  acked: number;
  resolved: number;
  ackSec: number;
  resolveSec: number;
  rules: Map<string, number>;
}

const acc = (): Acc => ({
  alerts: 0,
  events: 0,
  acked: 0,
  resolved: 0,
  ackSec: 0,
  resolveSec: 0,
  rules: new Map(),
});

function add(a: Acc, f: AlertFlow) {
  a.alerts += f.alerts;
  a.events += f.events;
  a.acked += f.acked;
  a.resolved += f.resolved;
  a.ackSec += f.ackSec;
  a.resolveSec += f.resolveSec;
  a.rules.set(f.ruleId, (a.rules.get(f.ruleId) ?? 0) + f.alerts);
}

const mean = (sum: number, n: number) => (n > 0 ? Math.round(sum / n) : null);
const round2 = (x: number) => Math.round(x * 100) / 100;

function getOr<K, V>(m: Map<K, V>, k: K, make: () => V): V {
  let v = m.get(k);
  if (v === undefined) m.set(k, (v = make()));
  return v;
}

export function buildGraph(input: GraphInput): GraphResponse {
  const { directory: dir } = input;
  const ruleName = new Map(dir.rules.map((r) => [r.id, r.name]));
  const teamName = new Map(dir.teams.map((t) => [t.id, t.name]));
  const userName = new Map(dir.users.map((u) => [u.id, u.name]));
  const sourceInfo = new Map(dir.sources.map((s) => [s.id, s]));

  const topRules = (counts: Map<string, number>): RuleCount[] =>
    [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_RULES)
      .map(([ruleId, alerts]) => ({ ruleId, name: ruleName.get(ruleId) ?? ruleId, alerts }));

  // Alert volume per source / rule / team, and the edges between them.
  const bySource = new Map<string, Acc>();
  const byRule = new Map<string, Acc>();
  const byTeam = new Map<string, Acc>();
  const ruleTeam = new Map<string, string>();
  const edges = new Map<string, GraphEdge>();
  const edge = (kind: GraphEdge['kind'], source: string, target: string, weight: number) => {
    const id = `${kind}:${source}->${target}`;
    const e = edges.get(id);
    if (e) e.weight += weight;
    else edges.set(id, { id, source, target, kind, weight });
  };

  for (const f of input.flows) {
    add(getOr(bySource, f.sourceId, acc), f);
    add(getOr(byRule, f.ruleId, acc), f);
    add(getOr(byTeam, f.teamId, acc), f);
    ruleTeam.set(f.ruleId, f.teamId);
    edge('alerts', `source:${f.sourceId}`, `rule:${f.ruleId}`, f.alerts);
    edge('alerts', `rule:${f.ruleId}`, `team:${f.teamId}`, f.alerts);
  }

  // People: notifications per team (→ edges and load), rules behind them, ACK / resolve times.
  const perUser = new Map<
    string,
    { alerts: number; byTeam: Map<string, number>; rules: Map<string, number> }
  >();
  for (const n of input.notifications) {
    const u = getOr(perUser, n.userId, () => ({ alerts: 0, byTeam: new Map(), rules: new Map() }));
    u.alerts += n.alerts;
    u.byTeam.set(n.teamId, (u.byTeam.get(n.teamId) ?? 0) + n.alerts);
    u.rules.set(n.ruleId, (u.rules.get(n.ruleId) ?? 0) + n.alerts);
    edge('notifications', `team:${n.teamId}`, `user:${n.userId}`, n.alerts);
    if (!byTeam.has(n.teamId)) byTeam.set(n.teamId, acc());
  }
  const escalated = new Map<string, number>();
  for (const e of input.escalations) {
    if (!userName.has(e.userId)) continue;
    escalated.set(e.userId, (escalated.get(e.userId) ?? 0) + e.n);
    edge('escalations', `team:${e.teamId}`, `user:${e.userId}`, e.n);
  }
  const acks = new Map(input.times.acks.map((a) => [a.userId!, a]));
  const resolves = new Map(input.times.resolves.map((r) => [r.userId!, r]));

  // Team average of notified alerts over the team's members (members without any count as 0).
  const teamMembers = new Map<string, Set<string>>();
  for (const m of dir.members) getOr(teamMembers, m.teamId, () => new Set()).add(m.userId);
  for (const [userId, u] of perUser)
    for (const teamId of u.byTeam.keys()) getOr(teamMembers, teamId, () => new Set()).add(userId);
  const teamAvg = new Map<string, number>();
  for (const [teamId, members] of teamMembers) {
    if (!byTeam.has(teamId)) continue;
    let sum = 0;
    for (const userId of members) sum += perUser.get(userId)?.byTeam.get(teamId) ?? 0;
    teamAvg.set(teamId, sum / members.size);
  }

  const nodes: GraphNode[] = [];
  const base = (a: Acc) => ({
    alerts: a.alerts,
    acked: a.acked,
    resolved: a.resolved,
    mttaSec: mean(a.ackSec, a.acked),
    mttrSec: mean(a.resolveSec, a.resolved),
    topRules: topRules(a.rules),
  });

  // Noise: a source's alerts against the mean of all sources in the range (1 = average).
  const meanSourceAlerts = bySource.size
    ? [...bySource.values()].reduce((s, a) => s + a.alerts, 0) / bySource.size
    : 0;
  for (const [id, a] of bySource) {
    const s = sourceInfo.get(id);
    nodes.push({
      id: `source:${id}`,
      kind: 'source',
      entityId: id,
      label: s?.systemName ?? id,
      ...(s && { sublabel: s.name, systemId: s.systemId }),
      ...base(a),
      events: a.events,
      noise: meanSourceAlerts ? round2(a.alerts / meanSourceAlerts) : 0,
    });
  }
  for (const [id, a] of byRule) {
    const teamId = ruleTeam.get(id);
    nodes.push({
      id: `rule:${id}`,
      kind: 'rule',
      entityId: id,
      label: ruleName.get(id) ?? id,
      ...(teamId && teamName.has(teamId) && { sublabel: teamName.get(teamId) }),
      ...base(a),
    });
  }
  for (const [id, a] of byTeam) {
    nodes.push({ id: `team:${id}`, kind: 'team', entityId: id, label: teamName.get(id) ?? id, ...base(a) });
  }

  // Everyone notified, plus the members of the teams on the graph (an idle member is information too).
  const people = new Set(perUser.keys());
  for (const teamId of byTeam.keys()) for (const userId of teamMembers.get(teamId) ?? []) people.add(userId);
  for (const userId of people) {
    if (!userName.has(userId)) continue;
    const u = perUser.get(userId);
    // Load against the team where this person handles the most alerts.
    const [mainTeam, inMain] = [...(u?.byTeam ?? [])].sort((a, b) => b[1] - a[1])[0] ?? [
      [...teamMembers].find(([, m]) => m.has(userId))?.[0],
      0,
    ];
    const avg = mainTeam ? (teamAvg.get(mainTeam) ?? 0) : 0;
    const ack = acks.get(userId);
    const res = resolves.get(userId);
    nodes.push({
      id: `user:${userId}`,
      kind: 'user',
      entityId: userId,
      label: userName.get(userId)!,
      ...(mainTeam && teamName.has(mainTeam) && { sublabel: teamName.get(mainTeam) }),
      alerts: u?.alerts ?? 0,
      acked: ack?.n ?? 0,
      resolved: res?.n ?? 0,
      mttaSec: ack ? mean(ack.sec, ack.n) : null,
      mttrSec: res ? mean(res.sec, res.n) : null,
      topRules: topRules(u?.rules ?? new Map()),
      notifications: u?.alerts ?? 0,
      escalations: escalated.get(userId) ?? 0,
      teamAvgAlerts: round2(avg),
      load: avg > 0 ? round2(inMain / avg) : 0,
    });
  }

  return { from: input.from, to: input.to, nodes, edges: [...edges.values()] };
}
