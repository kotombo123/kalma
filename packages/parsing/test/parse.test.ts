import { readFixture } from '@alerting/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { compileGrok, detectFormat, parse, parseLogfmtLine } from '../src/index.ts';

const fixture = readFixture;

const NDJSON = [
  '{"workflowId":"wf-1001","state":"FAILED","error":{"code":"TIMEOUT"}}',
  '{"workflowId":"wf-1002","state":"FAILED","error":{"code":"COUNTERPARTY_REJECT"}}',
  '{"workflowId":"wf-1003","state":"RETRYING","error":{"code":"TIMEOUT"}}',
].join('\n');

// Pattern documented for this fixture in packages/contracts/fixtures/README.md.
const PRICING_GROK =
  '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} \\[%{NOTSPACE:service}\\] %{WORD:instrument} %{GREEDYDATA:message}';

describe('detectFormat', () => {
  it('prefers source config over everything else', () => {
    expect(detectFormat({ body: '{"a":1}', format: 'logfmt', contentType: 'application/json' })).toBe(
      'logfmt',
    );
  });

  it('uses Content-Type when config is auto', () => {
    expect(detectFormat({ body: 'a=1', format: 'auto', contentType: 'application/json' })).toBe('json');
    expect(detectFormat({ body: 'x', contentType: 'application/x-ndjson' })).toBe('json');
    expect(detectFormat({ body: 'x', contentType: 'text/xml; charset=utf-8' })).toBe('xml');
    expect(detectFormat({ body: 'x', contentType: 'text/csv' })).toBe('csv');
  });

  it('treats configured regex / grok as regex format', () => {
    expect(detectFormat({ body: 'x', parserOptions: { grokPattern: '%{WORD:w}' } })).toBe('regex');
  });

  it.each([
    ['events/alertmanager-firing.json', 'json'],
    ['events/alertmanager-resolved.json', 'json'],
    ['events/workflow-failed.json', 'json'],
    ['events/trade-rejected.json', 'json'],
    ['events/judges-unknown.json', 'json'],
    ['events/settlement-batch.xml', 'xml'],
    ['events/reconciliation.csv', 'csv'],
    ['events/logfmt.log', 'logfmt'],
    ['events/pricing-engine.log', 'text'],
  ] as const)('sniffs %s as %s', (name, format) => {
    expect(detectFormat({ body: fixture(name), contentType: 'text/plain' })).toBe(format);
  });
});

describe('parse', () => {
  it('JSON object', () => {
    const r = parse({ body: fixture('events/workflow-failed.json') });
    expect(r).toMatchObject({ format: 'json', parseError: false });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      type: 'WORKFLOW_FAILED',
      workflowId: 'WF-20261023-00042',
      error: { code: 'TIMEOUT' },
    });
  });

  it.each([
    'events/alertmanager-firing.json',
    'events/alertmanager-resolved.json',
    'events/trade-rejected.json',
    'events/judges-unknown.json',
  ])('parses %s as one JSON record', (name) => {
    const r = parse({ body: fixture(name), contentType: 'application/json' });
    expect(r).toEqual({ format: 'json', parseError: false, records: [JSON.parse(fixture(name))] });
  });

  it('JSON array is a batch', () => {
    const r = parse({ body: '[{"a":1},{"a":2}]' });
    expect(r.records).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('NDJSON is a batch', () => {
    const r = parse({ body: NDJSON, contentType: 'application/x-ndjson' });
    expect(r).toMatchObject({ format: 'json', parseError: false });
    expect(r.records).toHaveLength(3);
    expect(r.records[1]).toMatchObject({ workflowId: 'wf-1002', error: { code: 'COUNTERPARTY_REJECT' } });
  });

  it('XML: nested elements, values left as strings', () => {
    const r = parse({ body: fixture('events/settlement-batch.xml') });
    expect(r).toMatchObject({ format: 'xml', parseError: false });
    expect(r.records[0]).toMatchObject({
      event: {
        type: 'SETTLEMENT_BATCH_FAILED',
        batchId: 'SB-20261023-07',
        priority: 'HIGH',
        details: { failedCount: '14', reason: 'Ledger unavailable' },
      },
    });
  });

  it('XML keeps attributes with @ prefix', () => {
    const r = parse({ body: '<trade id="T-1"><notional currency="EUR">25000000</notional></trade>' });
    expect(r.records[0]).toEqual({
      trade: { '@id': 'T-1', notional: { '#text': '25000000', '@currency': 'EUR' } },
    });
  });

  it('logfmt: one record per line, quoted values', () => {
    const r = parse({ body: fixture('events/logfmt.log') });
    expect(r).toMatchObject({ format: 'logfmt', parseError: false });
    expect(r.records).toEqual([
      {
        ts: '2026-10-23T09:16:00Z',
        level: 'error',
        service: 'counterparty-service',
        msg: 'upstream timeout',
        upstream: 'ledger',
        duration_ms: '5003',
        request_id: 'req-7781',
      },
    ]);
  });

  it('logfmt: bare keys are true, and sniffing still detects the line', () => {
    const body = 'level=warn msg="stale curve" retry';
    expect(detectFormat({ body })).toBe('logfmt');
    expect(parse({ body }).records).toEqual([{ level: 'warn', msg: 'stale curve', retry: true }]);
  });

  it('logfmt: escaped quotes and empty values', () => {
    expect(parseLogfmtLine('msg="say \\"hi\\"" empty= k=v')).toEqual({ msg: 'say "hi"', empty: '', k: 'v' });
  });

  it('CSV with header row', () => {
    const r = parse({ body: fixture('events/reconciliation.csv') });
    expect(r).toMatchObject({ format: 'csv', parseError: false });
    expect(r.records).toEqual([
      {
        timestamp: '2026-10-23T09:25:00Z',
        level: 'WARN',
        account: 'ACC-1001',
        expected: '1500000',
        actual: '1499000',
        message: 'Reconciliation mismatch',
      },
      {
        timestamp: '2026-10-23T09:25:00Z',
        level: 'CRIT',
        account: 'ACC-2002',
        expected: '900000',
        actual: '0',
        message: 'Account balance missing',
      },
    ]);
  });

  it('CSV with headers from source config', () => {
    const r = parse({
      body: 'RATES,BREACH\nFX,OK',
      format: 'csv',
      parserOptions: { csvHeaders: ['desk', 'status'] },
    });
    expect(r.records).toEqual([
      { desk: 'RATES', status: 'BREACH' },
      { desk: 'FX', status: 'OK' },
    ]);
  });

  it('regex with named groups, per line', () => {
    const r = parse({
      body: fixture('events/pricing-engine.log'),
      parserOptions: { regex: '^(?<ts>\\S+) (?<level>\\w+) \\[(?<service>[^\\]]+)\\] (?<message>.*)$' },
    });
    expect(r).toMatchObject({ format: 'regex', parseError: false });
    expect(r.records).toHaveLength(4);
    expect(r.records[2]).toEqual({
      ts: '2026-10-23T09:15:13.020Z',
      level: 'ERROR',
      service: 'pricing-engine-1',
      message: 'GBPUSD cache miss storm, falling back to slow path',
    });
  });

  it('grok pattern, per line, dotted field names', () => {
    const r = parse({
      body: fixture('events/pricing-engine.log'),
      parserOptions: { grokPattern: PRICING_GROK },
    });
    expect(r).toMatchObject({ format: 'regex', parseError: false });
    expect(r.records).toHaveLength(4);
    expect(r.records[0]).toEqual({
      ts: '2026-10-23T09:15:11.002Z',
      level: 'WARN',
      service: 'pricing-engine-3',
      instrument: 'EURUSD',
      message: 'quote latency 1240ms above threshold 1000ms',
    });

    const r2 = parse({
      body: 'E_TIMEOUT 503',
      parserOptions: { grokPattern: '%{WORD:error.code} %{INT:http.status}' },
    });
    expect(r2.records).toEqual([{ 'error.code': 'E_TIMEOUT', 'http.status': '503' }]);
  });

  it('plain text: one { message } per line', () => {
    const r = parse({ body: '!!! something odd happened @ node-7 :: code 0xDEAD' });
    expect(r).toEqual({
      format: 'text',
      parseError: false,
      records: [{ message: '!!! something odd happened @ node-7 :: code 0xDEAD' }],
    });
  });

  it.each([
    ['broken JSON', { body: '{"a": 1,', contentType: 'application/json' }],
    ['broken XML', { body: '<a><b></a>' }],
    ['grok mismatch', { body: 'nope', parserOptions: { grokPattern: '%{INT:n}' } }],
    ['regex without pattern', { body: 'x', format: 'regex' as const }],
    ['empty body', { body: '   ' }],
  ])('falls back to { message, _parseError } on %s', (_, input) => {
    const r = parse(input);
    expect(r.parseError).toBe(true);
    expect(r.records).toEqual([{ message: input.body, _parseError: true }]);
  });
});

describe('compileGrok', () => {
  it('throws on unknown pattern names', () => {
    expect(() => compileGrok('%{NOPE:x}')).toThrow(/unknown pattern/);
  });

  it('ships the ~20 base patterns', async () => {
    const { GROK_PATTERNS } = await import('../src/index.ts');
    expect(Object.keys(GROK_PATTERNS).length).toBeGreaterThanOrEqual(20);
  });
});
