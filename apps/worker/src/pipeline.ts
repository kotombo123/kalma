import { newId } from '@alerting/config';
import { Envelope, type Alert, type NormalizedEvent, type Rule } from '@alerting/contracts';
import { fingerprint, flatten, normalize } from '@alerting/schema';
import { render } from '@alerting/templates';
import type { AlertPort, DedupPort, DedupResult, RecentEventsPort, RulePort, SchemaPort } from './ports.ts';

export interface PipelineDeps {
  schemas: SchemaPort;
  rules: RulePort;
  dedup: DedupPort;
  alerts: AlertPort;
  recent: RecentEventsPort;
  now?: () => number;
  /** `ingest_to_worker`: per event read; `ingest_to_alert`: per alert written. */
  onLatency?: (stage: 'ingest_to_worker' | 'ingest_to_alert', ms: number) => void;
}

export interface BatchStats {
  events: number;
  invalid: number;
  unmatched: number;
  created: number;
  deduplicated: number;
  /** Alerts closed by a resolved event (B1-14). */
  resolved: number;
  /** Resolved events with no open alert, or whose rule has `autoResolve.onSourceResolved: false`. */
  resolvedSkipped: number;
}

/** Values templates can use: every flat path, plus the normalized `$` fields. */
export function templateData(e: NormalizedEvent): Record<string, unknown> {
  return {
    ...e.flat,
    $severity: e.severity,
    $source: e.sourceId,
    $schema: e.schemaId,
    $status: e.status,
    $entity: e.entity,
    $title: e.title,
    $timestamp: e.timestamp,
  };
}

/** `grouping.by` → one alert per distinct value tuple; otherwise the dedup key. */
export function groupKeyFor(rule: Rule, e: NormalizedEvent, data: Record<string, unknown>): string {
  if (rule.grouping?.by.length) {
    return `g:${rule.grouping.by.map((f) => String(data[f] ?? '')).join('|')}`;
  }
  const custom = rule.dedup.keyTemplate ? render(rule.dedup.keyTemplate, data) : '';
  return custom || e.dedupKey;
}

export function buildAlert(rule: Rule, e: NormalizedEvent, groupKey: string, id: string): Alert {
  const data = templateData(e);
  const p = rule.presentation;
  return {
    id,
    orgId: e.orgId,
    ruleId: rule.id,
    ruleVersion: rule.version,
    teamId: rule.teamId,
    sourceId: e.sourceId,
    schemaId: e.schemaId,
    groupKey,
    status: 'open',
    severity: p.severity ?? e.severity,
    title: render(p.titleTemplate, data) || e.title || rule.name,
    ...(p.bodyTemplate && { body: render(p.bodyTemplate, data) }),
    fields: p.fields.map((f) => ({
      label: f.label,
      value: render(f.template, data),
      ...(f.highlight && { highlight: f.highlight }),
    })),
    ...(p.color && { color: p.color }),
    count: 1,
    firstSeen: e.timestamp,
    lastSeen: e.timestamp,
    ingestTs: e.ingestTs,
    lastEvent: { raw: e.raw, flat: e.flat },
  };
}

/**
 * One `stream:events` batch: envelope → flatten → fingerprint → schema → normalize →
 * events:recent → rules → dedup → alerts. Throws only on infrastructure errors (the caller then
 * does not XACK, and the batch is retried); bad envelopes are counted and skipped.
 */
export async function processBatch(payloads: string[], deps: PipelineDeps): Promise<BatchStats> {
  const now = deps.now ?? Date.now;
  const stats: BatchStats = {
    events: 0,
    invalid: 0,
    unmatched: 0,
    created: 0,
    deduplicated: 0,
    resolved: 0,
    resolvedSkipped: 0,
  };
  const normalized: NormalizedEvent[] = [];
  const ignored = new Set<string>();

  for (const payload of payloads) {
    let envelope: Envelope;
    try {
      envelope = Envelope.parse(JSON.parse(payload));
    } catch {
      stats.invalid++;
      continue;
    }
    deps.onLatency?.('ingest_to_worker', now() - envelope.ingestTs);
    const flat = flatten(envelope.raw);
    const fp = fingerprint(flat);
    const schema = await deps.schemas.resolve({
      orgId: envelope.orgId,
      sourceId: envelope.sourceId,
      fingerprint: fp,
      flat,
      raw: envelope.raw,
    });
    if (schema.status === 'ignored') ignored.add(envelope.id);
    normalized.push(
      normalize({ envelope, schemaId: schema.schemaId, fingerprint: fp, flat, mapping: schema.mapping }),
    );
  }
  stats.events = normalized.length;
  if (normalized.length) await deps.recent.push(normalized);

  let created: Alert[] = [];
  const flush = async () => {
    if (!created.length) return;
    const batch = created;
    created = [];
    await deps.alerts.create(batch);
    stats.created += batch.length;
    for (const a of batch) deps.onLatency?.('ingest_to_alert', now() - a.ingestTs);
  };
  // Dedup checks of consecutive firing events go to Redis together (one pipelined round instead
  // of one per event); a resolved event settles everything before it first, so order is kept.
  let checks: { e: NormalizedEvent; rule: Rule; groupKey: string; result: Promise<DedupResult> }[] = [];
  const settle = async () => {
    const batch = checks;
    checks = [];
    const results = await Promise.all(batch.map((c) => c.result));
    batch.forEach(({ e, rule, groupKey }, i) => {
      const d = results[i]!;
      if (d.result === 'NEW') {
        created.push(buildAlert(rule, e, groupKey, d.alertId));
      } else {
        stats.deduplicated++;
        deps.alerts.bump({
          alertId: d.alertId,
          orgId: e.orgId,
          count: d.count,
          lastSeen: e.timestamp,
          lastEvent: { raw: e.raw, flat: e.flat },
        });
      }
    });
  };

  for (const e of normalized) {
    if (ignored.has(e.id)) {
      deps.schemas.count(e.schemaId, false);
      continue;
    }
    const matches = deps.rules.engineFor(e.orgId)?.match(e) ?? [];
    deps.schemas.count(e.schemaId, matches.length === 0);
    if (matches.length === 0) {
      stats.unmatched++;
      continue;
    }
    const data = templateData(e);
    for (const { rule } of matches) {
      const groupKey = groupKeyFor(rule, e, data);

      if (e.status === 'resolved') {
        // Resolved events never open alerts; they close one if the rule allows it.
        if (!rule.autoResolve.onSourceResolved) {
          stats.resolvedSkipped++;
          continue;
        }
        await settle();
        // The alert may have been opened earlier in this batch: insert it first.
        if (created.some((a) => a.ruleId === rule.id && a.groupKey === groupKey)) await flush();
        const closed = await deps.alerts.resolve({
          orgId: e.orgId,
          ruleId: rule.id,
          groupKey,
          resolvedAt: e.timestamp,
          eventId: e.id,
        });
        await deps.dedup.release(rule.id, groupKey);
        if (closed) stats.resolved++;
        else stats.resolvedSkipped++;
        continue;
      }

      const windowSec = rule.grouping?.windowSec ?? rule.dedup.windowSec;
      checks.push({
        e,
        rule,
        groupKey,
        result: deps.dedup.check(rule.id, groupKey, newId(), windowSec, now()),
      });
    }
  }
  await settle();

  await flush();
  return stats;
}
