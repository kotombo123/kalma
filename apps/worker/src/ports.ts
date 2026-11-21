import type { Alert, FlatRecord, Mapping, NormalizedEvent, SchemaStatus } from '@alerting/contracts';
import type { RuleEngine } from '@alerting/rules';

/** What the pipeline needs from the outside world; Postgres / Redis in production, memory in tests. */

export interface ResolvedSchema {
  schemaId: string;
  status: SchemaStatus;
  /** Saved mapping, else a detected preset's mapping, else undefined (guessed roles). */
  mapping?: Pick<Mapping, 'roles' | 'severityMap' | 'resolvedValues'>;
}

export interface SchemaPort {
  /** Finds or creates the schema for (org, fingerprint). Creation publishes `schema.discovered`. */
  resolve(input: {
    orgId: string;
    sourceId: string;
    fingerprint: string;
    flat: FlatRecord;
    raw: unknown;
  }): Promise<ResolvedSchema>;
  /** Event / unmatched counters, flushed in batches. */
  count(schemaId: string, unmatched: boolean): void;
}

export interface RulePort {
  engineFor(orgId: string): RuleEngine | undefined;
}

export type DedupResult = { result: 'NEW' | 'DUP'; alertId: string; count: number };

export interface DedupPort {
  /** Atomic across workers: exactly one caller per (rule, groupKey) window gets NEW. */
  check(
    ruleId: string,
    groupKey: string,
    candidateAlertId: string,
    windowSec: number,
    nowMs: number,
  ): Promise<DedupResult>;
  /** Ends the window (source said resolved), so the next firing event opens a new alert. */
  release(ruleId: string, groupKey: string): Promise<void>;
}

export interface AlertUpdate {
  alertId: string;
  orgId: string;
  count: number;
  lastSeen: string;
  lastEvent: Alert['lastEvent'];
}

export interface AlertResolve {
  orgId: string;
  ruleId: string;
  groupKey: string;
  resolvedAt: string;
  eventId: string;
}

export interface AlertPort {
  /** Inserts new alerts, then XADDs them to `stream:alerts` and publishes `alert.created`. */
  create(alerts: Alert[]): Promise<void>;
  /** Duplicates: count / lastSeen updates, coalesced and flushed in batches. */
  bump(update: AlertUpdate): void;
  /** Closes the open / acknowledged alert of (rule, groupKey); returns its id, if there was one. */
  resolve(input: AlertResolve): Promise<string | undefined>;
}

export interface RecentEventsPort {
  /** `events:recent:{orgId}` samples for rule preview. */
  push(events: NormalizedEvent[]): Promise<void>;
}
