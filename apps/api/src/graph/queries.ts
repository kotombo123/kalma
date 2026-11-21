/**
 * F-09 aggregates. Every query scans the alerts in scope once (visible to the viewer, first seen in
 * [from, to), optionally one team) and groups in Postgres; names are joined in JS from small tables.
 */
import { and, eq, gte, inArray, isNotNull, lt, sql, t, type Db, type SQL } from '@alerting/db';
import { visibleAlerts, type Viewer } from '../alerts/access.ts';

export interface Scope {
  viewer: Viewer;
  from: string;
  to: string;
  teamId?: string;
}

export function alertScope(db: Db, s: Scope): SQL {
  return and(
    visibleAlerts(db, s.viewer),
    gte(t.alerts.firstSeen, s.from),
    lt(t.alerts.firstSeen, s.to),
    s.teamId ? eq(t.alerts.teamId, s.teamId) : undefined,
  )!;
}

const int = (expr: SQL) => sql<number>`(${expr})::int`.mapWith(Number);
const num = (expr: SQL) => sql<number>`(${expr})::float8`.mapWith(Number);
const secs = (end: SQL | typeof t.alerts.ackAt, start = t.alerts.firstSeen) =>
  num(sql`coalesce(sum(extract(epoch from ${end} - ${start})), 0)`);

/** Alerts per (source, rule, team): volume, ACK / resolve counts and summed times. */
export function alertFlows(db: Db, scope: SQL) {
  return db
    .select({
      sourceId: t.alerts.sourceId,
      ruleId: t.alerts.ruleId,
      teamId: t.alerts.teamId,
      alerts: int(sql`count(*)`),
      events: int(sql`coalesce(sum(${t.alerts.count}), 0)`),
      acked: int(sql`count(${t.alerts.ackAt})`),
      resolved: int(sql`count(${t.alerts.resolvedAt})`),
      ackSec: secs(t.alerts.ackAt),
      resolveSec: secs(t.alerts.resolvedAt),
    })
    .from(t.alerts)
    .where(scope)
    .groupBy(t.alerts.sourceId, t.alerts.ruleId, t.alerts.teamId);
}
export type AlertFlow = Awaited<ReturnType<typeof alertFlows>>[number];

/**
 * Distinct alerts each person was notified about, per (team, rule). One alert can have several
 * deliveries to one person (channels, fallbacks): grouping by (alert, person) first lets Postgres
 * hash-aggregate twice instead of sorting for `count(distinct)` (~10x faster on 100k alerts).
 */
export async function notifications(db: Db, scope: SQL) {
  const rows = await db.execute<{ team_id: string; rule_id: string; user_id: string; n: number }>(sql`
    select team_id, rule_id, user_id, count(*)::int as n
    from (
      select ${t.alerts.teamId} as team_id, ${t.alerts.ruleId} as rule_id, ${t.deliveries.userId} as user_id
      from ${t.deliveries}
      join ${t.alerts} on ${t.alerts.id} = ${t.deliveries.alertId}
      where ${scope}
      group by ${t.alerts.id}, ${t.deliveries.userId}
    ) per_alert
    group by 1, 2, 3`);
  return [...rows].map((r) => ({
    teamId: r.team_id,
    ruleId: r.rule_id,
    userId: r.user_id,
    alerts: Number(r.n),
  }));
}
export type NotificationFlow = Awaited<ReturnType<typeof notifications>>[number];

/** Who acknowledged / resolved how many alerts, and how fast. */
export async function personTimes(db: Db, scope: SQL) {
  const [acks, resolves] = await Promise.all([
    db
      .select({ userId: t.alerts.ackBy, n: int(sql`count(*)`), sec: secs(t.alerts.ackAt) })
      .from(t.alerts)
      .where(and(scope, isNotNull(t.alerts.ackBy), isNotNull(t.alerts.ackAt)))
      .groupBy(t.alerts.ackBy),
    db
      .select({ userId: t.alerts.resolvedBy, n: int(sql`count(*)`), sec: secs(t.alerts.resolvedAt) })
      .from(t.alerts)
      .where(and(scope, isNotNull(t.alerts.resolvedBy), isNotNull(t.alerts.resolvedAt)))
      .groupBy(t.alerts.resolvedBy),
  ]);
  return { acks, resolves };
}
export type PersonTimes = Awaited<ReturnType<typeof personTimes>>;

/** Escalation recipients per (team, person), from `escalation` timeline entries. */
export async function escalations(db: Db, scope: SQL) {
  const rows = await db.execute<{ team_id: string; user_id: string; n: number }>(sql`
    select ${t.alerts.teamId} as team_id, r.user_id, count(*)::int as n
    from ${t.alertTimeline}
    join ${t.alerts} on ${t.alerts.id} = ${t.alertTimeline.alertId}
    cross join lateral jsonb_array_elements_text(
      coalesce(${t.alertTimeline.data} -> 'recipients', '[]'::jsonb)
    ) as r(user_id)
    where ${t.alertTimeline.kind} = 'escalation' and ${scope}
    group by 1, 2`);
  return [...rows].map((r) => ({ teamId: r.team_id, userId: r.user_id, n: Number(r.n) }));
}
export type EscalationFlow = Awaited<ReturnType<typeof escalations>>[number];

/** Names of everything that can appear in the graph (small, per-org tables). */
export async function orgDirectory(db: Db, orgId: string) {
  const [sources, rules, teams, users, members] = await Promise.all([
    db
      .select({
        id: t.sources.id,
        name: t.sources.name,
        systemId: t.sources.systemId,
        systemName: t.systems.name,
      })
      .from(t.sources)
      .innerJoin(t.systems, eq(t.systems.id, t.sources.systemId))
      .where(eq(t.sources.orgId, orgId)),
    db
      .select({ id: t.rules.id, name: t.rules.name, teamId: t.rules.teamId })
      .from(t.rules)
      .where(eq(t.rules.orgId, orgId)),
    db.select({ id: t.teams.id, name: t.teams.name }).from(t.teams).where(eq(t.teams.orgId, orgId)),
    db
      .select({ id: t.users.id, name: t.users.name })
      .from(t.users)
      .innerJoin(t.memberships, eq(t.memberships.userId, t.users.id))
      .where(eq(t.memberships.orgId, orgId)),
    db
      .select({ teamId: t.teamMembers.teamId, userId: t.teamMembers.userId })
      .from(t.teamMembers)
      .innerJoin(t.teams, eq(t.teams.id, t.teamMembers.teamId))
      .where(eq(t.teams.orgId, orgId)),
  ]);
  return { sources, rules, teams, users, members };
}
export type OrgDirectory = Awaited<ReturnType<typeof orgDirectory>>;

/** `GET /stats` pieces. */
export async function statsQueries(db: Db, scope: SQL) {
  const hour = sql<string>`date_trunc('hour', ${t.alerts.firstSeen})`;
  const [[totals], perHour, topRules, channels] = await Promise.all([
    db
      .select({
        alerts: int(sql`count(*)`),
        open: int(sql`count(*) filter (where ${t.alerts.status} = 'open')`),
        acknowledged: int(sql`count(*) filter (where ${t.alerts.status} = 'acknowledged')`),
        resolved: int(sql`count(*) filter (where ${t.alerts.status} = 'resolved')`),
        acked: int(sql`count(${t.alerts.ackAt})`),
        resolvedWithTime: int(sql`count(${t.alerts.resolvedAt})`),
        ackSec: secs(t.alerts.ackAt),
        resolveSec: secs(t.alerts.resolvedAt),
      })
      .from(t.alerts)
      .where(scope),
    db
      .select({ hour, alerts: int(sql`count(*)`) })
      .from(t.alerts)
      .where(scope)
      .groupBy(hour)
      .orderBy(hour),
    db
      .select({
        ruleId: t.alerts.ruleId,
        alerts: int(sql`count(*)`),
        events: int(sql`coalesce(sum(${t.alerts.count}), 0)`),
      })
      .from(t.alerts)
      .where(scope)
      .groupBy(t.alerts.ruleId)
      .orderBy(sql`count(*) desc`)
      .limit(10),
    db
      .select({ channel: t.deliveries.channel, status: t.deliveries.status, n: int(sql`count(*)`) })
      .from(t.deliveries)
      .innerJoin(t.alerts, eq(t.alerts.id, t.deliveries.alertId))
      .where(scope)
      .groupBy(t.deliveries.channel, t.deliveries.status),
  ]);
  return { totals: totals!, perHour, topRules, channels };
}

export async function ruleNames(db: Db, orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: t.rules.id, name: t.rules.name })
    .from(t.rules)
    .where(and(eq(t.rules.orgId, orgId), inArray(t.rules.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
}
