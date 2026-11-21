import { z } from 'zod';
import { Id, IsoDate, Severity } from './common.ts';

export const EventFormat = z.enum(['json', 'xml', 'logfmt', 'regex', 'csv', 'text']);
export type EventFormat = z.infer<typeof EventFormat>;

/** ingest → worker (`stream:events`, JSON in field `d`). */
export const Envelope = z.object({
  id: Id,
  orgId: Id,
  sourceId: Id,
  receivedAt: IsoDate,
  /** epoch ms — for end-to-end latency. */
  ingestTs: z.number(),
  format: EventFormat,
  /** Parsed payload. */
  raw: z.unknown(),
  /** Original text, truncated to 16 KB. */
  rawText: z.string().optional(),
  parseError: z.boolean().optional(),
});
export type Envelope = z.infer<typeof Envelope>;

export const FlatValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FlatValue = z.infer<typeof FlatValue>;
export const FlatRecord = z.record(z.string(), FlatValue);
export type FlatRecord = z.infer<typeof FlatRecord>;

export const EventStatus = z.enum(['firing', 'resolved']);
export type EventStatus = z.infer<typeof EventStatus>;

/** Result of the schema pipeline (worker; also `events:recent:{orgId}`). */
export const NormalizedEvent = z.object({
  id: Id,
  orgId: Id,
  sourceId: Id,
  ingestTs: z.number(),
  receivedAt: IsoDate,
  schemaId: Id,
  fingerprint: z.string(),
  severity: Severity,
  timestamp: IsoDate,
  title: z.string().optional(),
  message: z.string().optional(),
  dedupKey: z.string(),
  status: EventStatus,
  /** e.g. serviceName / workflowId */
  entity: z.string().optional(),
  raw: z.unknown(),
  flat: FlatRecord,
});
export type NormalizedEvent = z.infer<typeof NormalizedEvent>;
