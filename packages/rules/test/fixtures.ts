import { RuleFile, SEED, type NormalizedEvent, type Rule } from '@alerting/contracts';
import { readFixture } from '@alerting/contracts/fixtures';
import { parse } from '@alerting/parsing';
import { detectPreset, fingerprint, flatten, normalize } from '@alerting/schema';
import { parse as parseYaml } from 'yaml';

const TEAM: Record<string, string> = {
  settlements: SEED.teams.settlements,
  pricing: SEED.teams.pricing,
  rates: SEED.teams.rates,
  payments: SEED.teams.payments,
};

/** An Appendix B YAML rule as the YAML sync (B1-15) would store it: names resolved to ids. */
export function loadRule(name: string): Rule {
  const file = RuleFile.parse(parseYaml(readFixture(`rules/${name}`)));
  const { team, runbook: _runbook, ...rest } = file;
  return {
    ...rest,
    id: `rule-${name}`,
    orgId: SEED.orgId,
    teamId: TEAM[team!]!,
    routing: { ...rest.routing, targets: [] },
  } as Rule;
}

export const RULE_FILES = [
  'team-settlements.yaml',
  'team-pricing.yaml',
  'team-rates.yaml',
  'anna-payments-critical.yaml',
] as const;

const PRICING_GROK =
  '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} \\[%{NOTSPACE:service}\\] %{WORD:instrument} %{GREEDYDATA:message}';

/** Fixture → parse → flatten → preset → normalize: the events the worker would evaluate. */
export function loadEvents(name: string, sourceId: string = SEED.sources.http): NormalizedEvent[] {
  const parserOptions = name.endsWith('pricing-engine.log') ? { grokPattern: PRICING_GROK } : undefined;
  const { records } = parse({ body: readFixture(name), parserOptions });
  return records.map((raw, i) => {
    const flat = flatten(raw);
    const fp = fingerprint(flat);
    return normalize({
      envelope: {
        id: `${name}#${i}`,
        orgId: SEED.orgId,
        sourceId,
        ingestTs: 0,
        receivedAt: '2026-10-23T09:30:00.000Z',
        raw,
      },
      schemaId: `schema-${fp.slice(0, 8)}`,
      fingerprint: fp,
      flat,
      mapping: detectPreset(flat)?.mapping,
    });
  });
}
