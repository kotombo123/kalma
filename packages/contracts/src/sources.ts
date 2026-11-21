import { z } from 'zod';
import { Id, IsoDate, Severity } from './common.ts';
import { EventFormat } from './events.ts';

export const Transport = z.enum(['http', 'kafka', 'file', 'poll']);
export type Transport = z.infer<typeof Transport>;

export const HttpCfg = z.object({ transport: z.literal('http') });
export const KafkaCfg = z.object({
  transport: z.literal('kafka'),
  topic: z.string(),
  brokers: z.array(z.string()).optional(),
  fromBeginning: z.boolean().default(false),
});
export const FileCfg = z.object({
  transport: z.literal('file'),
  path: z.string(),
  /** Regex marking the start of a record (multi-line stack traces). */
  recordStart: z.string().optional(),
});
export const PollCfg = z.object({
  transport: z.literal('poll'),
  url: z.string(),
  intervalSec: z.number().int().positive().default(30),
  headers: z.record(z.string(), z.string()).optional(),
  itemsPath: z.string().optional(),
  idPath: z.string().optional(),
  sinceParam: z.string().optional(),
});
export const SourceConfig = z.discriminatedUnion('transport', [HttpCfg, KafkaCfg, FileCfg, PollCfg]);
export type SourceConfig = z.infer<typeof SourceConfig>;

export const ParserOptions = z.object({
  regex: z.string().optional(),
  grokPattern: z.string().optional(),
  csvHeaders: z.array(z.string()).optional(),
});
export type ParserOptions = z.infer<typeof ParserOptions>;

export const Source = z.object({
  id: Id,
  orgId: Id,
  /** system = group of sources */
  systemId: Id,
  name: z.string(),
  transport: Transport,
  config: SourceConfig,
  format: z.union([z.literal('auto'), EventFormat]),
  parserOptions: ParserOptions.optional(),
  enabled: z.boolean(),
  apiKeyPrefix: z.string().optional(),
  /** 'file' = managed by a connector file (config/connectors/*.yaml) */
  origin: z.enum(['ui', 'api', 'file']).optional(),
  filePath: z.string().nullable().optional(),
  fileError: z.string().nullable().optional(),
});
export type Source = z.infer<typeof Source>;

/**
 * Connector file (config/connectors/<name>.yaml): a person connects a new source by dropping this file.
 * Either a template with settings, or their own collector (Vector) config: `sources` and optional
 * `transforms`. Kalma adds the delivery to ingest itself. See docs/connectors/implementation_plan.md.
 */
export const ConnectorFile = z
  .object({
    connector: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase letters, digits and dashes'),
    system: z.string().min(1),
    name: z.string().min(1).max(100),
    template: z.string().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    collector: z
      .object({
        sources: z.record(z.string(), z.record(z.string(), z.unknown())),
        transforms: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      })
      .strict()
      .optional(),
    enabled: z.boolean().default(true),
  })
  .refine((c) => Boolean(c.template) !== Boolean(c.collector), {
    message: 'set either `template` or `collector`',
  });
export type ConnectorFile = z.infer<typeof ConnectorFile>;

/** A template setting: what a connector file may set, with a default and a range. */
export const ConnectorSetting = z.object({
  type: z.enum(['string', 'number', 'port', 'enum']),
  label: z.string(),
  default: z.unknown().optional(),
  values: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});
export const ConnectorTemplate = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  settings: z.record(z.string(), ConnectorSetting).default({}),
  example: z.string().optional(),
});
export type ConnectorTemplate = z.infer<typeof ConnectorTemplate>;

export const FieldRole = z.enum([
  'severity',
  'timestamp',
  'title',
  'dedupKey',
  'status',
  'entity',
  'message',
]);
export type FieldRole = z.infer<typeof FieldRole>;

export const RoleBinding = z.object({
  path: z.string().optional(),
  template: z.string().optional(),
  expr: z.string().optional(),
});
export type RoleBinding = z.infer<typeof RoleBinding>;

export const Mapping = z.object({
  id: Id,
  schemaId: Id,
  version: z.number().int(),
  roles: z.partialRecord(FieldRole, RoleBinding),
  /** "CRIT" → critical */
  severityMap: z.record(z.string(), Severity).optional(),
  /** e.g. ["resolved", "OK"] */
  resolvedValues: z.array(z.string()).optional(),
  presetId: z.string().optional(),
});
export type Mapping = z.infer<typeof Mapping>;

export const SchemaStatus = z.enum(['new', 'mapped', 'ignored']);
export type SchemaStatus = z.infer<typeof SchemaStatus>;

export const SchemaField = z.object({ path: z.string(), type: z.string(), example: z.unknown() });
export type SchemaField = z.infer<typeof SchemaField>;

export const GuessedRoles = z.partialRecord(
  FieldRole,
  z.object({ path: z.string(), confidence: z.number().min(0).max(1) }),
);
export type GuessedRoles = z.infer<typeof GuessedRoles>;

export const SchemaInfo = z.object({
  id: Id,
  orgId: Id,
  fingerprint: z.string(),
  sourceId: Id,
  name: z.string().optional(),
  status: SchemaStatus,
  fields: z.array(SchemaField),
  sample: z.unknown(),
  guessedRoles: GuessedRoles,
  mappingId: Id.optional(),
  eventCount: z.number().int(),
  unmatchedCount: z.number().int(),
  firstSeen: IsoDate.optional(),
  lastSeen: IsoDate.optional(),
});
export type SchemaInfo = z.infer<typeof SchemaInfo>;
