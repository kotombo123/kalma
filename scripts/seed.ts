/**
 * Idempotent seed: org "Kalma", users, teams, systems, one source per transport, rules (Appendix B),
 * runbooks (Appendix C), on-call, Anna's preferences, one sample alert. Run: `pnpm seed`.
 * All ids are stable (`SEED` in @alerting/contracts). Login: <user>@acme.test / demo.
 */
import { basename } from 'node:path';
import { hash } from '@node-rs/argon2';
import { parse } from 'yaml';
import {
  Alert,
  Rule,
  RuleFile,
  SEED,
  SEED_API_KEYS,
  SEED_PASSWORD,
  type ChannelType,
  type Condition,
  type RoutingTarget,
  type Severity,
  type SourceConfig,
} from '@alerting/contracts';
import { listFixtures, readFixture, readJsonFixture } from '@alerting/contracts/fixtures';
import { createDb, t, sql } from '@alerting/db';
import { parseMarkdown, parseText, parseYaml } from '@alerting/runbooks';
import {
  describeFields,
  detectPreset,
  fingerprint,
  flatten,
  guessRoles,
  type PresetMapping,
} from '@alerting/schema';
import { keyPrefix, sha256 } from './lib/keys.ts';

const { db, sql: pg } = createDb(undefined, 2);
const now = new Date().toISOString();
const passwordHash = await hash(SEED_PASSWORD);
const U = SEED.users;
const T = SEED.teams;

const users = [
  { id: U.admin, email: 'admin@acme.test', name: 'Admin' },
  { id: U.anna, email: 'anna@acme.test', name: 'Anna Kowalska' },
  { id: U.settlementsLead, email: 'sam@acme.test', name: 'Sam (Settlements lead)' },
  { id: U.settlementsMember, email: 'tom@acme.test', name: 'Tom (Settlements)' },
  { id: U.pricingLead, email: 'paula@acme.test', name: 'Paula (Pricing lead)' },
  { id: U.pricingMember, email: 'piotr@acme.test', name: 'Piotr (Pricing)' },
  { id: U.ratesLead, email: 'rita@acme.test', name: 'Rita (Rates lead)' },
  { id: U.ratesMember, email: 'radek@acme.test', name: 'Radek (Rates)' },
  { id: U.paymentsLead, email: 'pat@acme.test', name: 'Pat (Payments lead)' },
];

const teams = [
  { id: T.settlements, key: 'settlements', name: 'Settlements' },
  { id: T.pricing, key: 'pricing', name: 'Pricing' },
  { id: T.rates, key: 'rates', name: 'Rates' },
  { id: T.payments, key: 'payments', name: 'Payments' },
  { id: T.counterpartySupport, key: 'counterparty-support', name: 'Counterparty Support' },
];
const teamByKey = new Map(teams.map((x) => [x.key, x.id]));

const teamMembers: { teamId: string; userId: string; role: 'lead' | 'member' }[] = [
  { teamId: T.settlements, userId: U.settlementsLead, role: 'lead' },
  { teamId: T.settlements, userId: U.settlementsMember, role: 'member' },
  { teamId: T.settlements, userId: U.anna, role: 'member' },
  { teamId: T.pricing, userId: U.pricingLead, role: 'lead' },
  { teamId: T.pricing, userId: U.pricingMember, role: 'member' },
  { teamId: T.rates, userId: U.ratesLead, role: 'lead' },
  { teamId: T.rates, userId: U.ratesMember, role: 'member' },
  { teamId: T.payments, userId: U.paymentsLead, role: 'lead' },
  { teamId: T.payments, userId: U.anna, role: 'member' },
  { teamId: T.counterpartySupport, userId: U.settlementsLead, role: 'lead' },
];

const S = SEED.systems;
const systems = [
  { id: S.workflowEngine, name: 'Workflow engine', description: 'Order settlement workflows' },
  { id: S.payments, name: 'Payments', description: 'payments-api (Prometheus Alertmanager)' },
  { id: S.pricing, name: 'Pricing', description: 'pricing-engine-* instances' },
  { id: S.trading, name: 'Trading', description: 'trade-gateway, incidents API' },
];

const sources: {
  id: string;
  systemId: string;
  name: string;
  config: SourceConfig;
  format: string;
  key: string;
  parserOptions?: Record<string, unknown>;
}[] = [
  {
    id: SEED.sources.http,
    systemId: S.payments,
    name: 'Alertmanager webhook',
    config: { transport: 'http' },
    format: 'auto',
    key: SEED_API_KEYS.http,
  },
  {
    id: SEED.sources.kafka,
    systemId: S.workflowEngine,
    name: 'Kafka workflow-events',
    config: { transport: 'kafka', topic: 'workflow-events', fromBeginning: false },
    format: 'json',
    key: SEED_API_KEYS.kafka,
  },
  {
    id: SEED.sources.file,
    systemId: S.pricing,
    name: 'pricing-engine log',
    config: { transport: 'file', path: '/var/log/demo/pricing-engine.log' },
    format: 'regex',
    key: SEED_API_KEYS.file,
    parserOptions: {
      grokPattern:
        '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} \\[%{NOTSPACE:service}\\] %{WORD:instrument} %{GREEDYDATA:message}',
    },
  },
  {
    id: SEED.sources.poll,
    systemId: S.trading,
    name: 'Incidents API poller',
    config: {
      transport: 'poll',
      url: 'http://demo-systems:3002/incidents',
      intervalSec: 15,
      itemsPath: 'data.items',
      idPath: 'id',
    },
    format: 'json',
    key: SEED_API_KEYS.poll,
  },
];

const runbookFiles: Record<string, { id: string; teamId: string; format: 'yaml' | 'markdown' | 'text' }> = {
  'settlement-timeout.yaml': { id: SEED.runbooks.settlementTimeout, teamId: T.settlements, format: 'yaml' },
  'payments-high-error-rate.md': {
    id: SEED.runbooks.paymentsHighErrorRate,
    teamId: T.payments,
    format: 'markdown',
  },
  'pricing-latency.txt': { id: SEED.runbooks.pricingLatency, teamId: T.pricing, format: 'text' },
};
const runbookByName = new Map(
  Object.entries(runbookFiles).map(([f, r]) => [basename(f).replace(/\.[^.]+$/, ''), r.id]),
);

/** YAML shorthand `{ field: value }` → `{ all: [eq…] }`. */
const matchesOf = (raw: unknown): Condition | null =>
  raw && typeof raw === 'object' && !Array.isArray(raw)
    ? {
        all: Object.entries(raw as Record<string, unknown>).map(([field, value]) => ({
          field,
          op: 'eq' as const,
          value,
        })),
      }
    : null;

const ruleIds: Record<string, string> = {
  'team-settlements.yaml': SEED.rules.settlements,
  'team-pricing.yaml': SEED.rules.pricing,
  'team-rates.yaml': SEED.rules.rates,
  'anna-payments-critical.yaml': SEED.rules.anna,
};
const userByEmail = new Map(users.map((u) => [u.email, u.id]));

/** Severity → channels (in hours / off hours). Anna: critical → Telegram 08–20, email otherwise. */
const defaultPrefs: Record<Severity, [ChannelType[], ChannelType[]]> = {
  critical: [
    ['ui', 'email', 'telegram'],
    ['ui', 'telegram'],
  ],
  error: [
    ['ui', 'email'],
    ['ui', 'email'],
  ],
  warning: [['ui'], ['ui']],
  info: [['ui'], []],
};
const annaPrefs: Record<Severity, [ChannelType[], ChannelType[]]> = {
  critical: [
    ['ui', 'telegram'],
    ['ui', 'email'],
  ],
  error: [['ui', 'email'], ['ui']],
  warning: [['ui'], ['ui']],
  info: [['ui'], []],
};

function resolveRule(file: string) {
  const f = RuleFile.parse(parse(readFixture(`rules/${file}`)));
  const teamId = f.teamId ?? teamByKey.get(f.team ?? '');
  if (!teamId) throw new Error(`${file}: unknown team ${f.team}`);
  const targets: RoutingTarget[] = f.routing.targets.map((x) => {
    if ('teamId' in x || 'userId' in x) return x;
    if ('team' in x) {
      const id = teamByKey.get(x.team);
      if (!id) throw new Error(`${file}: unknown team ${x.team}`);
      return { type: x.type, teamId: id };
    }
    const id = userByEmail.get(x.email);
    if (!id) throw new Error(`${file}: unknown user ${x.email}`);
    return { type: 'user', userId: id };
  });
  const { team: _t, runbook, ...rest } = f;
  return Rule.parse({
    ...rest,
    id: ruleIds[file],
    orgId: SEED.orgId,
    teamId,
    runbookId: runbook ? runbookByName.get(runbook) : f.runbookId,
    routing: { ...f.routing, targets },
  });
}

await db.transaction(async (tx) => {
  await tx.insert(t.orgs).values({ id: SEED.orgId, name: 'Kalma' }).onConflictDoUpdate({ target: t.orgs.id, set: { name: 'Kalma' } });

  for (const u of users) {
    const workingHours = { days: [1, 2, 3, 4, 5, 6, 7], start: '08:00', end: '20:00' };
    await tx
      .insert(t.users)
      .values({ ...u, passwordHash, timezone: 'Europe/Warsaw', workingHours })
      .onConflictDoUpdate({ target: t.users.id, set: { name: u.name, workingHours } });
    await tx
      .insert(t.memberships)
      .values({ orgId: SEED.orgId, userId: u.id, role: u.id === U.admin ? 'admin' : 'member' })
      .onConflictDoNothing();
    await tx
      .insert(t.channelAddresses)
      .values({ userId: u.id, channel: 'email', address: u.email, verified: true })
      .onConflictDoNothing();
    const prefs = u.id === U.anna ? annaPrefs : defaultPrefs;
    for (const [severity, [inHours, offHours]] of Object.entries(prefs) as [
      Severity,
      [string[], string[]],
    ][]) {
      await tx
        .insert(t.channelPrefs)
        .values({ userId: u.id, severity, inHours, offHours })
        .onConflictDoUpdate({
          target: [t.channelPrefs.userId, t.channelPrefs.severity],
          set: { inHours, offHours },
        });
    }
  }

  for (const tm of teams) {
    await tx.insert(t.teams).values({ id: tm.id, orgId: SEED.orgId, name: tm.name }).onConflictDoNothing();
  }
  await tx.insert(t.teamMembers).values(teamMembers).onConflictDoNothing();
  await tx
    .insert(t.systems)
    .values(systems.map((s) => ({ ...s, orgId: SEED.orgId })))
    .onConflictDoNothing();

  for (const s of sources) {
    const { key, ...rest } = s;
    await tx
      .insert(t.sources)
      .values({
        ...rest,
        orgId: SEED.orgId,
        transport: s.config.transport,
        apiKeyHash: sha256(key),
        apiKeyPrefix: keyPrefix(key),
      })
      .onConflictDoUpdate({
        target: t.sources.id,
        set: { config: s.config, format: s.format, parserOptions: s.parserOptions ?? null },
      });
  }

  // Steps are parsed by @alerting/runbooks (B2), same as POST /runbooks does.
  for (const file of listFixtures('runbooks')) {
    const r = runbookFiles[file];
    if (!r) continue;
    const source = readFixture(`runbooks/${file}`);
    const parsed =
      r.format === 'yaml'
        ? parseYaml(source)
        : r.format === 'markdown'
          ? parseMarkdown(source)
          : parseText(source);
    await tx
      .insert(t.runbooks)
      .values({
        id: r.id,
        orgId: SEED.orgId,
        teamId: r.teamId,
        name: file.replace(/\.[^.]+$/, ''),
        format: r.format,
        source,
        steps: parsed.steps,
        matches: matchesOf(parsed.matchesRaw),
      })
      .onConflictDoUpdate({
        target: t.runbooks.id,
        set: { steps: parsed.steps, matches: matchesOf(parsed.matchesRaw) },
      });
  }

  for (const file of listFixtures('rules')) {
    const rule = resolveRule(file);
    await tx
      .insert(t.rules)
      .values({
        id: rule.id,
        orgId: rule.orgId,
        teamId: rule.teamId,
        name: rule.name,
        enabled: rule.enabled,
        version: rule.version,
        definition: rule,
        origin: 'file',
        filePath: `config/rules/${file}`,
      })
      .onConflictDoUpdate({ target: t.rules.id, set: { definition: rule, name: rule.name } });
    await tx
      .insert(t.ruleVersions)
      .values({ ruleId: rule.id, version: rule.version, definition: rule, authorId: U.admin })
      .onConflictDoNothing();
  }

  await tx
    .insert(t.oncallSchedules)
    .values([
      {
        id: SEED.schedules.settlements,
        teamId: T.settlements,
        rotation: 'weekly',
        handoffTime: '09:00',
        timezone: 'Europe/Warsaw',
        participants: [U.settlementsMember, U.anna, U.settlementsLead],
        startDate: '2026-01-05',
      },
      {
        id: SEED.schedules.pricing,
        teamId: T.pricing,
        rotation: 'daily',
        handoffTime: '08:00',
        timezone: 'Europe/Warsaw',
        participants: [U.pricingMember, U.pricingLead],
        startDate: '2026-01-05',
      },
    ])
    .onConflictDoNothing();

  // One mapped schema + one open alert so the UI has data from the start. The fingerprint is
  // computed exactly like the worker does, so real workflow-failed events land in this schema.
  const alert = Alert.parse(readJsonFixture('alert.sample.json'));
  const flat = flatten(alert.lastEvent.raw);
  const mapping: PresetMapping = detectPreset(flat)?.mapping ?? {
    roles: Object.fromEntries(Object.entries(guessRoles(flat)).map(([role, g]) => [role, { path: g.path }])),
  };
  const [schemaRow] = await tx
    .insert(t.schemas)
    .values({
      id: SEED.schemas.workflowFailed,
      orgId: SEED.orgId,
      sourceId: SEED.sources.kafka,
      fingerprint: fingerprint(flat),
      name: 'Workflow failure',
      status: 'mapped',
      fields: describeFields(flat),
      guessedRoles: guessRoles(flat),
      sample: alert.lastEvent.raw,
      mappingId: SEED.mappings.workflowFailed,
    })
    .onConflictDoNothing() // id or (org, fingerprint) already there — e.g. the worker saw this event first
    .returning({ id: t.schemas.id });
  if (schemaRow) {
    await tx
      .insert(t.mappings)
      .values({
        id: SEED.mappings.workflowFailed,
        schemaId: schemaRow.id,
        version: 1,
        roles: mapping.roles,
        severityMap: mapping.severityMap ?? null,
        resolvedValues: mapping.resolvedValues ?? null,
        presetId: mapping.presetId ?? null,
        createdBy: U.admin,
      })
      .onConflictDoNothing();
  }
  await tx
    .insert(t.alerts)
    .values({ ...alert, dispatchedAt: now, escalationLevel: 0 })
    .onConflictDoNothing();
});

const [{ count }] = (await db.execute(sql`select count(*)::int as count from users`)) as unknown as [
  { count: number },
];
console.log(`seed ok — org Kalma, ${count} users (password "${SEED_PASSWORD}")`);
await pg.end();
