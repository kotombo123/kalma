import { readFixture, readJsonFixture } from '@alerting/contracts/fixtures';
import { parse } from '@alerting/parsing';
import { describe, expect, it } from 'vitest';
import { describeFields, fingerprint, flatten, normalizePath } from '../src/index.ts';

const fp = (raw: unknown) => fingerprint(flatten(raw));

describe('flatten', () => {
  it('joins nested keys with dots and indexes arrays', () => {
    expect(
      flatten({
        type: 'WORKFLOW_FAILED',
        error: { code: 'TIMEOUT', retryable: false },
        labels: ['a', 'b'],
        alerts: [{ labels: { severity: 'critical' } }],
        endsAt: null,
        notional: 25000000,
      }),
    ).toEqual({
      type: 'WORKFLOW_FAILED',
      'error.code': 'TIMEOUT',
      'error.retryable': false,
      'labels[0]': 'a',
      'labels[1]': 'b',
      'alerts[0].labels.severity': 'critical',
      endsAt: null,
      notional: 25000000,
    });
  });

  it('flattens the Appendix A Alertmanager event', () => {
    expect(flatten(readJsonFixture('events/alertmanager-firing.json'))).toEqual({
      alertname: 'HighErrorRate',
      'labels.service': 'payments-api',
      'labels.region': 'eu-west',
      'labels.severity': 'critical',
      'annotations.summary': 'Error rate 12% over the last 5 minutes',
      startsAt: '2026-10-23T09:13:00Z',
      status: 'firing',
    });
  });

  it('handles roots that are arrays or primitives', () => {
    expect(flatten([{ a: 1 }, { a: 2 }])).toEqual({ '[0].a': 1, '[1].a': 2 });
    expect(flatten('just text')).toEqual({ value: 'just text' });
  });

  it('skips empty containers and undefined, stringifies odd leaves', () => {
    expect(
      flatten({ a: {}, b: [], c: undefined, d: Number.NaN, e: 10n, f: new Date(0), g: () => 1 }),
    ).toEqual({ d: 'NaN', e: '10', f: '1970-01-01T00:00:00.000Z' });
  });

  it('stores containers past the depth limit as JSON', () => {
    const deep = { l1: { l2: { l3: { l4: 'x' } } } };
    expect(flatten(deep, { maxDepth: 2 })).toEqual({ 'l1.l2': '{"l3":{"l4":"x"}}' });

    let nested: unknown = 'leaf';
    for (let i = 0; i < 12; i++) nested = { n: nested };
    const flat = flatten(nested);
    const [path, value] = Object.entries(flat)[0]!;
    expect(path.split('.')).toHaveLength(8);
    expect(JSON.parse(value as string)).toEqual({ n: { n: { n: { n: 'leaf' } } } });
  });

  it('stops at the field limit', () => {
    const wide = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(flatten(wide))).toHaveLength(500);
    expect(Object.keys(flatten(wide, { maxFields: 10 }))).toHaveLength(10);
  });
});

describe('fingerprint', () => {
  const workflow = readJsonFixture<Record<string, unknown>>('events/workflow-failed.json');

  it('is a sha1 hex digest', () => {
    expect(fp(workflow)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('ignores values: same schema, other values → same fingerprint', () => {
    const other = {
      ...workflow,
      workflowId: 'WF-20261024-00001',
      step: 'book-payment',
      error: { code: 'COUNTERPARTY_REJECT', message: 'Rejected' },
    };
    expect(fp(other)).toBe(fp(workflow));
  });

  it('ignores key order at every level', () => {
    const reversed = Object.fromEntries(
      Object.entries(workflow)
        .reverse()
        .map(([k, v]) => [
          k,
          v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse()) : v,
        ]),
    );
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(workflow));
    expect(fp(reversed)).toBe(fp(workflow));
  });

  it('ignores array lengths', () => {
    expect(fp({ alerts: [{ id: 'a' }] })).toBe(fp({ alerts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
    expect(normalizePath('alerts[12].labels[0]')).toBe('alerts[].labels[]');
  });

  it('changes when a field is added, removed or retyped', () => {
    const base = fp(workflow);
    expect(fp({ ...workflow, extra: 'x' })).not.toBe(base);
    const { step: _step, ...withoutStep } = workflow;
    expect(fp(withoutStep)).not.toBe(base);
    expect(fp({ ...workflow, severity: 3 })).not.toBe(base);
    expect(fp({ ...workflow, severity: null })).not.toBe(base);
  });

  it('gives every Appendix A / fixture event its own fingerprint', () => {
    const names = [
      'events/workflow-failed.json',
      'events/alertmanager-firing.json',
      'events/trade-rejected.json',
      'events/judges-unknown.json',
    ];
    const prints = names.map((n) => fp(readJsonFixture(n)));
    expect(new Set(prints).size).toBe(names.length);
  });

  it('Alertmanager resolved adds endsAt, so it is a different schema than firing', () => {
    // Expected: presets (B1-05) recognise both by a path subset and map them the same way.
    const firing = fp(readJsonFixture('events/alertmanager-firing.json'));
    const resolved = fp(readJsonFixture('events/alertmanager-resolved.json'));
    expect(resolved).not.toBe(firing);
  });

  it('works end to end on every parsed fixture format', () => {
    const cases: [string, object?][] = [
      ['events/settlement-batch.xml'],
      ['events/reconciliation.csv'],
      ['events/logfmt.log'],
      [
        'events/pricing-engine.log',
        {
          grokPattern:
            '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} \\[%{NOTSPACE:service}\\] %{GREEDYDATA:message}',
        },
      ],
    ];
    for (const [name, parserOptions] of cases) {
      const { records, parseError } = parse({ body: readFixture(name), parserOptions });
      expect(parseError, name).toBe(false);
      // all records of one source share a schema (CSV rows, log lines)
      const prints = new Set(records.map(fp));
      expect(prints.size, name).toBe(1);
    }
  });
});

describe('describeFields', () => {
  it('lists normalized paths with type and first example, sorted', () => {
    expect(describeFields(flatten({ b: 1, a: { x: null }, items: [{ id: 'i1' }, { id: 'i2' }] }))).toEqual([
      { path: 'a.x', type: 'null', example: null },
      { path: 'b', type: 'number', example: 1 },
      { path: 'items[].id', type: 'string', example: 'i1' },
    ]);
  });
});
