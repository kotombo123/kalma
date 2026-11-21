import {
  RuleFile,
  SEED,
  type Alert,
  type Envelope,
  type NormalizedEvent,
  type Rule,
} from '@alerting/contracts';
import { readFixture } from '@alerting/contracts/fixtures';
import { parse } from '@alerting/parsing';
import { createEngine } from '@alerting/rules';
import { detectPreset } from '@alerting/schema';
import { parse as parseYaml } from 'yaml';
import { memoryDedup } from '../src/dedup.ts';
import type { PipelineDeps } from '../src/pipeline.ts';
import type { AlertUpdate, ResolvedSchema } from '../src/ports.ts';

const TEAM: Record<string, string> = {
  settlements: SEED.teams.settlements,
  pricing: SEED.teams.pricing,
  rates: SEED.teams.rates,
  payments: SEED.teams.payments,
};

/** Appendix B YAML rule with names resolved, as the seed stores it. */
export function loadRule(file: string): Rule {
  const f = RuleFile.parse(parseYaml(readFixture(`rules/${file}`)));
  const { team, runbook: _r, ...rest } = f;
  return {
    ...rest,
    id: `rule-${file.replace('.yaml', '')}`,
    orgId: SEED.orgId,
    teamId: TEAM[team!]!,
    routing: { ...rest.routing, targets: [{ type: 'team', teamId: TEAM[team!]! }] },
  } as Rule;
}

export const ALL_RULES = [
  'team-settlements.yaml',
  'team-pricing.yaml',
  'team-rates.yaml',
  'anna-payments-critical.yaml',
];

let seq = 0;
/** Envelopes as ingest would put them on stream:events (JSON in field d). */
export function envelopes(
  fixture: string,
  opts: { sourceId?: string; parserOptions?: object; ingestTs?: number } = {},
): string[] {
  const { records, format, parseError } = parse({
    body: readFixture(fixture),
    parserOptions: opts.parserOptions,
  });
  const ingestTs = opts.ingestTs ?? Date.now();
  return records.map((raw) => {
    const e: Envelope = {
      id: `01ENV${String(++seq).padStart(21, '0')}`,
      orgId: SEED.orgId,
      sourceId: opts.sourceId ?? SEED.sources.http,
      receivedAt: new Date(ingestTs).toISOString(),
      ingestTs,
      format,
      raw,
      ...(parseError && { parseError: true }),
    };
    return JSON.stringify(e);
  });
}

export const PRICING_GROK =
  '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} \\[%{NOTSPACE:service}\\] %{WORD:instrument} %{GREEDYDATA:message}';

/** All pipeline ports in memory. */
export function memoryDeps(rules: Rule[], opts: { ignored?: string[] } = {}) {
  const schemas = new Map<string, ResolvedSchema & { events: number; unmatched: number }>();
  const created: Alert[] = [];
  const updates = new Map<string, AlertUpdate>();
  const recent: NormalizedEvent[] = [];
  const engine = createEngine(rules);
  const dedup = memoryDedup();

  const deps: PipelineDeps = {
    schemas: {
      async resolve({ fingerprint, flat }) {
        let s = schemas.get(fingerprint);
        if (!s) {
          s = {
            schemaId: `schema-${fingerprint.slice(0, 8)}`,
            status: opts.ignored?.includes(fingerprint) ? 'ignored' : 'new',
            mapping: detectPreset(flat)?.mapping,
            events: 0,
            unmatched: 0,
          };
          schemas.set(fingerprint, s);
        }
        return s;
      },
      count(schemaId, unmatched) {
        const s = [...schemas.values()].find((x) => x.schemaId === schemaId)!;
        s.events++;
        if (unmatched) s.unmatched++;
      },
    },
    rules: { engineFor: (orgId) => (orgId === SEED.orgId ? engine : undefined) },
    dedup,
    alerts: {
      async create(alerts) {
        created.push(...alerts);
      },
      bump(u) {
        const prev = updates.get(u.alertId);
        if (!prev || prev.count < u.count) updates.set(u.alertId, u);
      },
      async resolve(r) {
        const open = created.find(
          (a) => a.ruleId === r.ruleId && a.groupKey === r.groupKey && a.status !== 'resolved',
        );
        if (!open) return undefined;
        Object.assign(open, { status: 'resolved', resolvedBy: 'system', resolvedAt: r.resolvedAt });
        return open.id;
      },
    },
    recent: {
      async push(events) {
        recent.push(...events);
      },
    },
  };
  return { deps, schemas, created, updates, recent, dedup };
}
