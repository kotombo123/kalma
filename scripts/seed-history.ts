/**
 * Demo history for the dependency graph and stats (F-09 / F-20): ~2000 alerts over the last 14 days
 * on top of `pnpm seed`, with deliveries, ACKs, resolves and escalations. Deterministic (fixed PRNG
 * seed), idempotent (deletes its own rows first, by id prefix). Run: `pnpm seed:history`.
 *
 * Shapes the demo should show:
 * - noisy system: the pricing engine raises more than half of all alerts;
 * - overloaded person: the Settlements lead gets most Settlements alerts, escalations and the
 *   Counterparty Support duty, and acknowledges slower than the rest.
 */
import { SEED, type ChannelType, type Severity } from '@alerting/contracts';
import { createDb, sql, t } from '@alerting/db';

const PREFIX = '01HIST';
const DAYS = 14;
const U = SEED.users;
const T = SEED.teams;

/** mulberry32: small deterministic PRNG, so every run produces the same history. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20261121);
const pick = <T>(weighted: [T, number][]): T => {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of weighted) if ((r -= w) <= 0) return v;
  return weighted.at(-1)![0];
};
/** Exponential-ish duration around `meanMin` minutes, in ms. */
const minutes = (meanMin: number) => Math.max(0.5, -Math.log(1 - rand()) * meanMin) * 60_000;

interface Flow {
  ruleId: string;
  teamId: string;
  sourceId: string;
  count: number;
  severity: [Severity, number][];
  titles: string[];
  /** Who gets notified (weights), and how slow each person acknowledges (mean minutes). */
  responders: [userId: string, weight: number, mttaMin: number][];
  /** Share of alerts escalated to the team lead. */
  escalate: number;
  lead: string;
}

const FLOWS: Flow[] = [
  {
    ruleId: SEED.rules.pricing,
    teamId: T.pricing,
    sourceId: SEED.sources.file,
    count: 1100,
    severity: [
      ['warning', 7],
      ['error', 3],
    ],
    titles: [
      'EURUSD quote latency above threshold',
      'GBPUSD stale price',
      'USDJPY quote latency above threshold',
    ],
    responders: [
      [U.pricingLead, 1, 6],
      [U.pricingMember, 1, 7],
    ],
    escalate: 0.02,
    lead: U.pricingLead,
  },
  {
    ruleId: SEED.rules.settlements,
    teamId: T.settlements,
    sourceId: SEED.sources.kafka,
    count: 460,
    severity: [
      ['critical', 6],
      ['error', 4],
    ],
    titles: ['order-settlement failed at validate-counterparty', 'order-settlement failed at book-cash'],
    responders: [
      [U.settlementsLead, 8, 22],
      [U.settlementsMember, 1.5, 6],
      [U.anna, 1, 5],
    ],
    escalate: 0.12,
    lead: U.settlementsLead,
  },
  {
    ruleId: SEED.rules.rates,
    teamId: T.rates,
    sourceId: SEED.sources.kafka,
    count: 240,
    severity: [['error', 1]],
    titles: ['Rejected EUR trade — LIMIT_BREACH', 'Rejected USD trade — PRICE_TOLERANCE'],
    responders: [
      [U.ratesLead, 1, 8],
      [U.ratesMember, 1, 9],
    ],
    escalate: 0.03,
    lead: U.ratesLead,
  },
  {
    ruleId: SEED.rules.anna,
    teamId: T.payments,
    sourceId: SEED.sources.http,
    count: 200,
    severity: [['critical', 1]],
    titles: ['HighErrorRate on payments-api (eu-west)', 'HighLatency on payments-api (eu-central)'],
    responders: [
      [U.anna, 1.7, 4],
      [U.paymentsLead, 1, 7],
    ],
    escalate: 0.04,
    lead: U.paymentsLead,
  },
];
const CHANNELS: [ChannelType, number][] = [
  ['email', 5],
  ['telegram', 3],
  ['ui', 2],
];

const { db, sql: pg } = createDb(undefined, 2);
const now = Date.now();
const start = now - DAYS * 86_400_000;
let seq = 0;
const nextId = (kind: 'A' | 'D' | 'T') =>
  `${PREFIX}${kind}${String(++seq).padStart(26 - PREFIX.length - 1, '0')}`;
const iso = (ms: number) => new Date(ms).toISOString();

const alerts: (typeof t.alerts.$inferInsert)[] = [];
const deliveries: (typeof t.deliveries.$inferInsert)[] = [];
const timeline: (typeof t.alertTimeline.$inferInsert)[] = [];

for (const f of FLOWS) {
  for (let i = 0; i < f.count; i++) {
    // Busier during working hours (08–18 UTC): retry a few times to land in them.
    let first = start + rand() * (now - start);
    for (let k = 0; k < 2 && (new Date(first).getUTCHours() < 8 || new Date(first).getUTCHours() > 18); k++)
      first = start + rand() * (now - start);
    const id = nextId('A');
    const [userId, , mttaMin] = pick(f.responders.map((r) => [r, r[1]] as [typeof r, number]));
    const severity = pick(f.severity);
    const ageMin = (now - first) / 60_000;

    const ackAfter = minutes(mttaMin);
    const resolveAfter = ackAfter + minutes(45);
    const acked = ageMin * 60_000 > ackAfter && rand() < 0.92;
    const resolved = acked && ageMin * 60_000 > resolveAfter && rand() < 0.9;
    const escalated = rand() < f.escalate && f.lead !== userId;
    const count = 1 + Math.floor(-Math.log(1 - rand()) * (f.ruleId === SEED.rules.pricing ? 6 : 2));

    alerts.push({
      id,
      orgId: SEED.orgId,
      ruleId: f.ruleId,
      ruleVersion: 1,
      teamId: f.teamId,
      sourceId: f.sourceId,
      schemaId: SEED.schemas.workflowFailed,
      groupKey: `hist-${id}`,
      status: resolved ? 'resolved' : acked ? 'acknowledged' : 'open',
      severity,
      title: f.titles[Math.floor(rand() * f.titles.length)]!,
      count,
      firstSeen: iso(first),
      lastSeen: iso(first + Math.min(ageMin * 60_000, count * 60_000)),
      ingestTs: Math.floor(first),
      lastEvent: { raw: { demo: true }, flat: { demo: true } },
      ...(acked && { ackBy: userId, ackAt: iso(first + ackAfter) }),
      ...(resolved && { resolvedBy: userId, resolvedAt: iso(first + resolveAfter) }),
      // Already handled: the notifier must not dispatch or escalate history.
      dispatchedAt: iso(first),
      escalationLevel: escalated ? 1 : 0,
      nextEscalationAt: null,
    });

    const notify = (to: string, at: number) => {
      const channel = pick(CHANNELS);
      const failed = rand() < 0.04;
      deliveries.push({
        id: nextId('D'),
        alertId: id,
        userId: to,
        channel,
        address: channel === 'email' ? 'demo@acme.test' : 'demo',
        status: failed ? 'failed' : 'sent',
        attempts: failed ? 3 : 1,
        nextAttemptAt: iso(at),
        ...(failed ? { lastError: 'demo: channel unavailable' } : { sentAt: iso(at + 2_000) }),
      });
    };
    notify(userId, first);
    timeline.push({
      id: nextId('T'),
      alertId: id,
      ts: iso(first),
      actorType: 'system',
      kind: 'created',
      data: {},
    });
    if (escalated) {
      const at = first + 15 * 60_000;
      notify(f.lead, at);
      timeline.push({
        id: nextId('T'),
        alertId: id,
        ts: iso(at),
        actorType: 'system',
        kind: 'escalation',
        data: { level: 1, recipients: [f.lead] },
      });
    }
    if (acked)
      timeline.push({
        id: nextId('T'),
        alertId: id,
        ts: iso(first + ackAfter),
        actorType: 'user',
        actorId: userId,
        kind: 'ack',
        data: {},
      });
    if (resolved)
      timeline.push({
        id: nextId('T'),
        alertId: id,
        ts: iso(first + resolveAfter),
        actorType: 'user',
        actorId: userId,
        kind: 'resolve',
        data: {},
      });
  }
}

const like = `${PREFIX}%`;
await db.transaction(async (tx) => {
  // Deliveries and timeline go with their alerts (ON DELETE CASCADE).
  await tx.delete(t.alerts).where(sql`${t.alerts.id} like ${like}`);
  for (const [table, rows] of [
    [t.alerts, alerts],
    [t.deliveries, deliveries],
    [t.alertTimeline, timeline],
  ] as const)
    for (let i = 0; i < rows.length; i += 500) await tx.insert(table).values(rows.slice(i, i + 500) as never);
});

console.log(
  `seed:history ok — ${alerts.length} alerts, ${deliveries.length} deliveries, ${timeline.length} timeline entries over ${DAYS} days`,
);
await pg.end();
