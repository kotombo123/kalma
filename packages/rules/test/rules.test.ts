import { SEED, type Condition, type Rule } from '@alerting/contracts';
import { describe, expect, it } from 'vitest';
import {
  compileCondition,
  createEngine,
  globToRegExp,
  preview,
  validateCondition,
  validateRule,
} from '../src/index.ts';
import type { RuleTarget } from '../src/index.ts';
import { loadEvents, loadRule, RULE_FILES } from './fixtures.ts';

const event = (flat: RuleTarget['flat'], extra: Partial<RuleTarget> = {}): RuleTarget => ({
  flat,
  severity: 'error',
  sourceId: 'src-1',
  schemaId: 'sch-1',
  status: 'firing',
  ...extra,
});
const check = (c: Condition, e: RuleTarget) => compileCondition(c)(e);

describe('Appendix B rules on the fixture events', () => {
  const events = {
    workflow: loadEvents('events/workflow-failed.json'),
    alertmanager: loadEvents('events/alertmanager-firing.json'),
    trade: loadEvents('events/trade-rejected.json'),
    pricing: loadEvents('events/pricing-engine.log'),
    judges: loadEvents('events/judges-unknown.json'),
    logfmt: loadEvents('events/logfmt.log'),
  };
  const all = Object.values(events).flat();
  const engine = createEngine(RULE_FILES.map(loadRule));
  const matchedBy = (name: string) =>
    all.filter((e) => engine.match(e).some((c) => c.rule.id === `rule-${name}`)).map((e) => e.id);

  it('all four rules are valid', () => {
    for (const name of RULE_FILES) expect(validateRule(loadRule(name))).toMatchObject({ ok: true });
  });

  it('Team Settlements: WORKFLOW_FAILED, order-settlement, prod', () => {
    expect(matchedBy('team-settlements.yaml')).toEqual(['events/workflow-failed.json#0']);
    const nonProd = { ...events.workflow[0]!, flat: { ...events.workflow[0]!.flat, environment: 'uat' } };
    expect(engine.match(nonProd)).toEqual([]);
  });

  it('Team Pricing: pricing-engine-* at WARN or above (3 of 4 log lines)', () => {
    expect(matchedBy('team-pricing.yaml')).toEqual([
      'events/pricing-engine.log#0',
      'events/pricing-engine.log#1',
      'events/pricing-engine.log#2',
    ]);
  });

  it('Team Rates: trade.rejected.*, desk rates, notional > 10M', () => {
    expect(matchedBy('team-rates.yaml')).toEqual(['events/trade-rejected.json#0']);
    const small = { ...events.trade[0]!, flat: { ...events.trade[0]!.flat, 'payload.notional': 5_000_000 } };
    expect(engine.match(small)).toEqual([]);
  });

  it('Anna: critical from payments-api', () => {
    expect(matchedBy('anna-payments-critical.yaml')).toEqual(['events/alertmanager-firing.json#0']);
  });

  it('the judges event and the counterparty log match no rule (they show up as unmatched)', () => {
    expect(engine.match(events.judges[0]!)).toEqual([]);
    expect(engine.match(events.logfmt[0]!)).toEqual([]);
  });

  it('preview: "would catch 3 of 8"', () => {
    const r = preview(loadRule('team-pricing.yaml'), all, 2);
    expect(r).toMatchObject({ matched: 3, total: all.length });
    expect(r.examples.map((e) => e.id)).toEqual([
      'events/pricing-engine.log#0',
      'events/pricing-engine.log#1',
    ]);
  });
});

describe('operators', () => {
  const e = event({
    amount: 1500000,
    code: 'TIMEOUT',
    name: 'pricing-engine-3',
    note: 'Counterparty DOWN',
    n: '42',
    z: null,
  });

  it.each<[Condition, boolean]>([
    [{ field: 'code', op: 'eq', value: 'TIMEOUT' }, true],
    [{ field: 'n', op: 'eq', value: 42 }, true], // number vs numeric string
    [{ field: 'code', op: 'neq', value: 'TIMEOUT' }, false],
    [{ field: 'amount', op: 'gt', value: 1000000 }, true],
    [{ field: 'amount', op: 'gte', value: 1500000 }, true],
    [{ field: 'amount', op: 'lt', value: '2000000' }, true],
    [{ field: 'amount', op: 'lte', value: 1499999 }, false],
    [{ field: 'code', op: 'gt', value: 1 }, false], // text is not a number
    [{ field: 'code', op: 'in', value: ['TIMEOUT', 'REJECTED'] }, true],
    [{ field: 'code', op: 'nin', value: ['TIMEOUT'] }, false],
    [{ field: 'note', op: 'contains', value: 'down' }, true], // case-insensitive
    [{ field: 'code', op: 'matches', value: '^TIME' }, true],
    [{ field: 'name', op: 'glob', value: 'pricing-engine-*' }, true],
    [{ field: 'name', op: 'glob', value: 'pricing-engine-?' }, true],
    [{ field: 'name', op: 'glob', value: 'pricing.*' }, false], // dot is literal
    [{ field: 'code', op: 'exists' }, true],
    [{ field: 'z', op: 'exists' }, false], // null counts as missing
    [{ field: 'nope', op: 'exists', value: false }, true],
  ])('%j → %s', (c, expected) => {
    expect(check(c, e)).toBe(expected);
  });

  it('missing fields: only neq, nin and exists:false are true', () => {
    for (const op of [
      'eq',
      'gt',
      'gte',
      'lt',
      'lte',
      'in',
      'contains',
      'matches',
      'glob',
      'exists',
    ] as const) {
      expect(check({ field: 'missing', op, value: op === 'in' ? ['x'] : 'x' }, e)).toBe(false);
    }
    expect(check({ field: 'missing', op: 'neq', value: 'x' }, e)).toBe(true);
    expect(check({ field: 'missing', op: 'nin', value: ['x'] }, e)).toBe(true);
  });

  it('normalized $fields, with severity ordering for comparisons', () => {
    const w = event({}, { severity: 'warning', entity: 'payments-api', title: 'High error rate' });
    expect(check({ field: '$severity', op: 'gte', value: 'warning' }, w)).toBe(true);
    expect(check({ field: '$severity', op: 'gt', value: 'warning' }, w)).toBe(false);
    expect(check({ field: '$severity', op: 'lt', value: 'critical' }, w)).toBe(true);
    expect(check({ field: '$source', op: 'eq', value: 'src-1' }, w)).toBe(true);
    expect(check({ field: '$schema', op: 'eq', value: 'sch-1' }, w)).toBe(true);
    expect(check({ field: '$status', op: 'eq', value: 'firing' }, w)).toBe(true);
    expect(check({ field: '$entity', op: 'glob', value: 'payments-*' }, w)).toBe(true);
    expect(check({ field: '$title', op: 'contains', value: 'error' }, w)).toBe(true);
  });

  it('all / any / not, including empty lists', () => {
    const yes: Condition = { field: 'code', op: 'eq', value: 'TIMEOUT' };
    const no: Condition = { field: 'code', op: 'eq', value: 'OTHER' };
    expect(check({ all: [yes, yes] }, e)).toBe(true);
    expect(check({ all: [yes, no] }, e)).toBe(false);
    expect(check({ any: [no, yes] }, e)).toBe(true);
    expect(check({ any: [no, no] }, e)).toBe(false);
    expect(check({ not: no }, e)).toBe(true);
    expect(check({ all: [] }, e)).toBe(true);
    expect(check({ any: [] }, e)).toBe(false);
    expect(check({ all: [{ any: [no, { not: no }] }, yes] }, e)).toBe(true);
  });

  it('globToRegExp escapes regex characters', () => {
    expect(globToRegExp('a.b+(c)*').test('a.b+(c)xyz')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('createEngine: candidate index', () => {
  const base = loadRule('team-settlements.yaml');
  const rule = (id: string, scope?: Rule['scope'], enabled = true): Rule => ({
    ...base,
    id,
    enabled,
    scope,
    condition: { all: [] },
  });
  const engine = createEngine([
    rule('global'),
    rule('src-a', { sourceIds: ['A'] }),
    rule('schema-x', { schemaIds: ['X'] }),
    rule('src-a-schema-y', { sourceIds: ['A'], schemaIds: ['Y'] }),
    rule('disabled', undefined, false),
  ]);
  const ids = (sourceId: string, schemaId: string) =>
    engine.match(event({}, { sourceId, schemaId })).map((c) => c.rule.id);

  it('picks rules by source / schema scope, keeps load order, skips disabled', () => {
    expect(ids('A', 'X')).toEqual(['global', 'src-a', 'schema-x']);
    expect(ids('A', 'Y')).toEqual(['global', 'src-a', 'src-a-schema-y']);
    expect(ids('B', 'X')).toEqual(['global', 'schema-x']);
    expect(ids('B', 'Z')).toEqual(['global']);
    expect(engine.rules.map((c) => c.rule.id)).not.toContain('disabled');
  });
});

describe('validation', () => {
  const fields = [
    { path: 'payload.notional', type: 'number', example: 1 },
    { path: 'payload.desk', type: 'string', example: 'rates' },
    { path: 'alerts[].labels.severity', type: 'string', example: 'x' },
  ];

  it('accepts a valid condition against known fields (array paths normalized)', () => {
    expect(
      validateCondition(
        {
          all: [
            { field: 'payload.notional', op: 'gt', value: 10000000 },
            { field: 'alerts[0].labels.severity', op: 'in', value: ['critical'] },
            { field: '$severity', op: 'gte', value: 'warning' },
          ],
        },
        fields,
      ),
    ).toEqual([]);
  });

  it('rejects $severity / $status values outside their enum', () => {
    const issues = validateCondition({
      any: [
        { field: '$severity', op: 'eq', value: 'loud' },
        { field: '$severity', op: 'in', value: ['critical', 'CRIT'] },
        { field: '$status', op: 'neq', value: 'open' },
        { field: '$status', op: 'nin', value: ['resolved'] },
        { field: '$severity', op: 'in', value: ['warning', 'error'] },
      ],
    });
    expect(issues.map((i) => i.path)).toEqual([
      'condition.any[0].value',
      'condition.any[1].value',
      'condition.any[2].value',
    ]);
    expect(issues[1]!.message).toContain('"CRIT"');
  });

  it('reports each problem with its path', () => {
    const issues = validateCondition(
      {
        any: [
          { field: 'payload.desk', op: 'gt', value: 5 },
          { field: 'payload.nope', op: 'eq', value: 'x' },
          { field: '$sev', op: 'eq', value: 'critical' },
          { field: 'payload.notional', op: 'in', value: [] },
          { field: 'payload.desk', op: 'matches', value: '([' },
          { field: 'payload.notional', op: 'gte', value: 'lots' },
          { field: 'payload.desk', op: 'exists', value: 'yes' },
          { field: 'payload.desk', op: 'eq', value: ['a'] },
        ],
      },
      fields,
    );
    expect(issues.map((i) => i.path)).toEqual([
      'condition.any[0].op',
      'condition.any[1].field',
      'condition.any[2].field',
      'condition.any[3].value',
      'condition.any[4].value',
      'condition.any[5].value',
      'condition.any[6].value',
      'condition.any[7].value',
    ]);
  });

  it('validateRule: contract errors and bad templates', () => {
    expect(validateRule({ name: 'x' })).toMatchObject({ ok: false });
    const rule = {
      ...loadRule('team-rates.yaml'),
      presentation: {
        titleTemplate: '{{payload.reason | nope}}',
        fields: [{ label: 'A', template: '{{#if x}}' }],
      },
    };
    const r = validateRule(rule);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.map((i) => i.path)).toEqual([
        'presentation.titleTemplate',
        'presentation.fields[0].template',
      ]);
    }
  });

  it('validateRule returns the parsed rule with defaults', () => {
    const { autoResolve: _a, origin: _o, ...input } = loadRule('team-rates.yaml');
    const r = validateRule({ ...input, orgId: SEED.orgId });
    expect(r.ok && r.value.origin).toBe('ui');
    expect(r.ok && r.value.autoResolve).toEqual({ onSourceResolved: true, onRunbookSuccess: false });
  });
});
