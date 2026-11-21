/** Postgres schema (implementation_plan.md §6). Ids are ULID text. Times are timestamptz (UTC). */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  Alert,
  Condition,
  FieldRole,
  GuessedRoles,
  ParserOptions,
  RoleBinding,
  RuleInput,
  RunbookInstanceStep,
  RunbookStep,
  SchemaField,
  Severity,
  SourceConfig,
  WorkingHours,
} from '@alerting/contracts';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const orgs = pgTable('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('Europe/Warsaw'),
  workingHours: jsonb('working_hours').$type<WorkingHours>(),
  createdAt: createdAt(),
});

export const memberships = pgTable(
  'memberships',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const teams = pgTable('teams', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  teamsWebhookUrl: text('teams_webhook_url'),
  createdAt: createdAt(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['lead', 'member'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
  teamRole: text('team_role', { enum: ['lead', 'member'] }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  createdAt: createdAt(),
});

export const systems = pgTable('systems', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
});

export const sources = pgTable('sources', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  systemId: text('system_id')
    .notNull()
    .references(() => systems.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  transport: text('transport', { enum: ['http', 'kafka', 'file', 'poll'] }).notNull(),
  config: jsonb('config').$type<SourceConfig>().notNull(),
  format: text('format').notNull().default('auto'),
  parserOptions: jsonb('parser_options').$type<ParserOptions>(),
  /** sha256 hex of the API key */
  apiKeyHash: text('api_key_hash').notNull().unique(),
  apiKeyPrefix: text('api_key_prefix').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** 'file' = managed by a connector file in config/connectors/ (read-only in the UI) */
  origin: text('origin', { enum: ['ui', 'api', 'file'] })
    .notNull()
    .default('ui'),
  filePath: text('file_path'),
  /** last validation error of the connector file; the previous config keeps running */
  fileError: text('file_error'),
  createdAt: createdAt(),
});

export const schemas = pgTable(
  'schemas',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    name: text('name'),
    status: text('status', { enum: ['new', 'mapped', 'ignored'] })
      .notNull()
      .default('new'),
    fields: jsonb('fields').$type<SchemaField[]>().notNull().default([]),
    sample: jsonb('sample'),
    guessedRoles: jsonb('guessed_roles').$type<GuessedRoles>().notNull().default({}),
    mappingId: text('mapping_id'),
    eventCount: bigint('event_count', { mode: 'number' }).notNull().default(0),
    unmatchedCount: bigint('unmatched_count', { mode: 'number' }).notNull().default(0),
    firstSeen: ts('first_seen').notNull().defaultNow(),
    lastSeen: ts('last_seen').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('schemas_org_fingerprint').on(t.orgId, t.fingerprint)],
);

export const mappings = pgTable(
  'mappings',
  {
    id: text('id').primaryKey(),
    schemaId: text('schema_id')
      .notNull()
      .references(() => schemas.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    roles: jsonb('roles').$type<Partial<Record<FieldRole, RoleBinding>>>().notNull(),
    severityMap: jsonb('severity_map').$type<Record<string, Severity>>(),
    resolvedValues: jsonb('resolved_values').$type<string[]>(),
    presetId: text('preset_id'),
    createdBy: text('created_by'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mappings_schema_version').on(t.schemaId, t.version)],
);

export const runbooks = pgTable('runbooks', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  format: text('format', { enum: ['yaml', 'markdown', 'checklist', 'link', 'text'] }).notNull(),
  source: text('source').notNull(),
  matches: jsonb('matches').$type<Condition>(),
  steps: jsonb('steps').$type<RunbookStep[]>().notNull().default([]),
  version: integer('version').notNull().default(1),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const rules = pgTable(
  'rules',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    /** whole `Rule` object */
    definition: jsonb('definition').$type<RuleInput>().notNull(),
    origin: text('origin', { enum: ['ui', 'api', 'file'] })
      .notNull()
      .default('ui'),
    filePath: text('file_path'),
    fileError: text('file_error'),
    updatedBy: text('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('rules_org').on(t.orgId)],
);

export const ruleVersions = pgTable(
  'rule_versions',
  {
    ruleId: text('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<RuleInput>().notNull(),
    authorId: text('author_id'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.version] })],
);

export const alerts = pgTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    ruleId: text('rule_id').notNull(),
    ruleVersion: integer('rule_version').notNull(),
    teamId: text('team_id').notNull(),
    sourceId: text('source_id').notNull(),
    schemaId: text('schema_id').notNull(),
    groupKey: text('group_key').notNull(),
    status: text('status', { enum: ['open', 'acknowledged', 'resolved'] })
      .notNull()
      .default('open'),
    severity: text('severity', { enum: ['critical', 'error', 'warning', 'info'] }).notNull(),
    title: text('title').notNull(),
    body: text('body'),
    fields: jsonb('fields').$type<Alert['fields']>().notNull().default([]),
    color: text('color'),
    count: integer('count').notNull().default(1),
    firstSeen: ts('first_seen').notNull(),
    lastSeen: ts('last_seen').notNull(),
    ingestTs: bigint('ingest_ts', { mode: 'number' }).notNull(),
    lastEvent: jsonb('last_event').$type<Alert['lastEvent']>().notNull(),
    groupMembers: jsonb('group_members').$type<string[]>(),
    runbookInstanceId: text('runbook_instance_id'),
    ackBy: text('ack_by'),
    ackAt: ts('ack_at'),
    resolvedBy: text('resolved_by'),
    resolvedAt: ts('resolved_at'),
    dispatchedAt: ts('dispatched_at'),
    escalationLevel: integer('escalation_level').notNull().default(0),
    nextEscalationAt: ts('next_escalation_at'),
  },
  (t) => [
    index('alerts_org_status_last_seen').on(t.orgId, t.status, t.lastSeen.desc()),
    index('alerts_undispatched')
      .on(t.dispatchedAt)
      .where(sql`${t.dispatchedAt} is null`),
    index('alerts_escalation')
      .on(t.nextEscalationAt)
      .where(sql`${t.status} = 'open'`),
    index('alerts_rule_group').on(t.ruleId, t.groupKey),
  ],
);

export const alertTimeline = pgTable(
  'alert_timeline',
  {
    id: text('id').primaryKey(),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    ts: ts('ts').notNull().defaultNow(),
    actorType: text('actor_type', { enum: ['user', 'system'] }).notNull(),
    actorId: text('actor_id'),
    kind: text('kind', {
      enum: ['created', 'ack', 'resolve', 'step', 'action', 'approval', 'delivery', 'escalation', 'comment'],
    }).notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('alert_timeline_alert').on(t.alertId, t.ts)],
);

export const runbookInstances = pgTable('runbook_instances', {
  id: text('id').primaryKey(),
  alertId: text('alert_id')
    .notNull()
    .references(() => alerts.id, { onDelete: 'cascade' }),
  runbookId: text('runbook_id').notNull(),
  runbookVersion: integer('runbook_version').notNull(),
  steps: jsonb('steps').$type<RunbookInstanceStep[]>().notNull(),
  createdAt: createdAt(),
});

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    stepId: text('step_id').notNull(),
    code: text('code').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired'] })
      .notNull()
      .default('pending'),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    decidedBy: text('decided_by'),
    decidedAt: ts('decided_at'),
    via: text('via', { enum: ['ui', 'telegram', 'email'] }),
  },
  (t) => [index('approvals_code').on(t.code)],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    alertId: text('alert_id')
      .notNull()
      .references(() => alerts.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    channel: text('channel', {
      enum: ['ui', 'email', 'telegram', 'teams', 'sms', 'phone'],
    }).notNull(),
    address: text('address').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: ['pending', 'sending', 'sent', 'failed', 'skipped'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lastError: text('last_error'),
    sentAt: ts('sent_at'),
    fallbackOf: text('fallback_of'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('deliveries_alert_user_channel').on(t.alertId, t.userId, t.channel),
    index('deliveries_pending')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export const channelPrefs = pgTable(
  'channel_prefs',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    severity: text('severity', { enum: ['critical', 'error', 'warning', 'info'] }).notNull(),
    inHours: text('in_hours').array().notNull(),
    offHours: text('off_hours').array().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.severity] })],
);

export const channelAddresses = pgTable(
  'channel_addresses',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel', {
      enum: ['ui', 'email', 'telegram', 'teams', 'sms', 'phone'],
    }).notNull(),
    address: text('address').notNull(),
    verified: boolean('verified').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.channel] })],
);

export const telegramLinkCodes = pgTable('telegram_link_codes', {
  code: text('code').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
});

export const oncallSchedules = pgTable('oncall_schedules', {
  id: text('id').primaryKey(),
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  rotation: text('rotation', { enum: ['daily', 'weekly'] }).notNull(),
  handoffTime: text('handoff_time').notNull().default('09:00'),
  timezone: text('timezone').notNull().default('Europe/Warsaw'),
  participants: text('participants').array().notNull(),
  startDate: text('start_date').notNull(),
});

export const oncallOverrides = pgTable('oncall_overrides', {
  id: text('id').primaryKey(),
  scheduleId: text('schedule_id')
    .notNull()
    .references(() => oncallSchedules.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  startsAt: ts('starts_at').notNull(),
  endsAt: ts('ends_at').notNull(),
});

/** Reserved extension point — not implemented. */
export const suggestions = pgTable('suggestions', {
  id: text('id').primaryKey(),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  targetId: text('target_id'),
  text: text('text').notNull(),
  data: jsonb('data'),
  createdAt: createdAt(),
});
