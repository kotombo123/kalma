import { readFixture, readJsonFixture } from '@alerting/contracts/fixtures';
import { parse as parseBody } from '@alerting/parsing';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { compile, lookup, render, renderTemplate, validateTemplate } from '../src/index.ts';

type RuleFile = {
  presentation: {
    titleTemplate: string;
    bodyTemplate?: string;
    fields: { label: string; template: string }[];
  };
  dedup?: { keyTemplate?: string };
};
/** Flat record like @alerting/schema's flatten() (objects only; enough for these fixtures). */
const flatten = (o: Record<string, unknown>, prefix = ''): Record<string, unknown> =>
  Object.entries(o).reduce<Record<string, unknown>>((acc, [k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object'
      ? { ...acc, ...flatten(v as Record<string, unknown>, path) }
      : { ...acc, [path]: v };
  }, {});

const rule = (name: string) => parseYaml(readFixture(`rules/${name}`)) as RuleFile;

const PRICING_GROK =
  '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} \\[%{NOTSPACE:service}\\] %{WORD:instrument} %{GREEDYDATA:message}';

describe('Appendix B rule templates', () => {
  const trade = readJsonFixture<Record<string, unknown>>('events/trade-rejected.json');

  it('Team Rates title renders on the raw event and on the flat record alike', () => {
    const { presentation, dedup } = rule('team-rates.yaml');
    const expected = 'Rejected EUR 25000000 — LIMIT_BREACH';
    expect(render(presentation.titleTemplate, trade)).toBe(expected);
    expect(render(presentation.titleTemplate, flatten(trade))).toBe(expected);
    expect(presentation.fields.map((f) => render(f.template, trade))).toEqual([
      'T-998877',
      '25,000,000 EUR',
      'LIMIT_BREACH',
    ]);
    expect(render(dedup!.keyTemplate!, trade)).toBe('T-998877');
  });

  it('Team Settlements on the workflow failure', () => {
    const { presentation } = rule('team-settlements.yaml');
    const wf = readJsonFixture<Record<string, unknown>>('events/workflow-failed.json');
    expect(render(presentation.titleTemplate, wf)).toBe('order-settlement failed at validate-counterparty');
    expect(render(presentation.bodyTemplate!, flatten(wf))).toBe(
      'TIMEOUT: Counterparty service did not respond in 5000 ms',
    );
  });

  it('Team Pricing on a grok-parsed log line', () => {
    const { presentation } = rule('team-pricing.yaml');
    const [line] = parseBody({
      body: readFixture('events/pricing-engine.log'),
      parserOptions: { grokPattern: PRICING_GROK },
    }).records;
    expect(render(presentation.titleTemplate, line as Record<string, unknown>)).toBe(
      'pricing-engine-3: EURUSD — quote latency 1240ms above threshold 1000ms',
    );
  });

  it('Anna on the Alertmanager event', () => {
    const { presentation } = rule('anna-payments-critical.yaml');
    const am = readJsonFixture<Record<string, unknown>>('events/alertmanager-firing.json');
    expect(render(presentation.titleTemplate, am)).toBe('HighErrorRate on payments-api (eu-west)');
    expect(render(presentation.bodyTemplate!, am)).toBe('Error rate 12% over the last 5 minutes');
  });
});

describe('render', () => {
  it('missing values render empty; objects as JSON', () => {
    expect(render('[{{nope}}] [{{a.b.c}}]', { a: 1 })).toBe('[] []');
    expect(render('{{labels}}', { labels: { a: 'x' } })).toBe('{"a":"x"}');
  });

  it('looks up arrays by index and flat keys with dots', () => {
    const data = { alerts: [{ labels: { severity: 'warning' } }], 'error.code': 'TIMEOUT' };
    expect(render('{{alerts[0].labels.severity}} {{error.code}}', data)).toBe('warning TIMEOUT');
    expect(lookup({ a: [10, 20] }, 'a[1]')).toBe(20);
    expect(lookup({ a: 'x' }, 'a.length')).toBeUndefined();
    expect(lookup({}, 'constructor')).toBeUndefined();
  });

  it('applies filters left to right, with quoted args', () => {
    const data = { s: 'Hello World', n: 25000000, ts: '2026-10-23T09:14:02.331Z', empty: '' };
    expect(render('{{s | upper}} {{s | lower}}', data)).toBe('HELLO WORLD hello world');
    expect(render('{{s | truncate:5}}', data)).toBe('Hell…');
    expect(render('{{s | truncate:50}}', data)).toBe('Hello World');
    expect(render('{{n | number}} {{n | number:2}}', data)).toBe('25,000,000 25,000,000.00');
    expect(render('{{n | currency:EUR}} {{n | currency:USD}}', data)).toBe('€25,000,000.00 $25,000,000.00');
    expect(render('{{n | currency}} {{n | currency:XYZ1}}', data)).toBe('25,000,000.00 25,000,000.00 XYZ1');
    expect(render('{{ts | date}}', data)).toBe('2026-10-23 09:14:02');
    expect(render('{{ts | date:"dd.MM.yyyy HH:mm"}}', data)).toBe('23.10.2026 09:14');
    expect(render('{{when | date:yyyy-MM-dd}}', { when: 1792834000 })).toBe('2026-10-24');
    expect(render('{{empty | default:"n/a"}} {{missing | default:\'none, really\'}}', data)).toBe(
      'n/a none, really',
    );
    expect(render('{{s | json}} {{missing | json}}', data)).toBe('"Hello World" null');
    expect(render('{{s | lower | truncate:4 | upper}}', data)).toBe('HEL…');
  });

  it('filters leave values they cannot handle unchanged', () => {
    expect(render('{{s | number}} {{s | date}} {{s | currency:EUR}}', { s: 'abc' })).toBe('abc abc abc');
  });

  it('if / else sections, nested', () => {
    const t = '{{#if error}}Error: {{error.code}}{{#if retry}} (retrying){{/if}}{{else}}OK{{/if}}';
    expect(render(t, { error: { code: 'TIMEOUT' }, retry: true })).toBe('Error: TIMEOUT (retrying)');
    expect(render(t, { error: { code: 'TIMEOUT' } })).toBe('Error: TIMEOUT');
    expect(render(t, {})).toBe('OK');
    for (const falsy of [null, false, '', 0, []]) expect(render(t, { error: falsy })).toBe('OK');
  });

  it('html option escapes values, not template text', () => {
    const data = { msg: '<script>alert("x")</script> & co' };
    expect(render('<b>{{msg}}</b>', data, { html: true })).toBe(
      '<b>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</b>',
    );
    expect(render('<b>{{msg}}</b>', data)).toBe('<b><script>alert("x")</script> & co</b>');
  });

  it('never executes code: expressions are not paths and are rejected', () => {
    for (const t of ['{{constructor.constructor("return 1")()}}', '{{a + b}}', '{{process.exit()}}']) {
      expect(validateTemplate(t).ok).toBe(false);
      expect(render(t, { a: 1, b: 2 })).toBe(t); // unchanged, no throw
    }
  });

  it('is the same function as renderTemplate (the name B2 injects)', () => {
    expect(renderTemplate).toBe(render);
  });
});

describe('compile / validateTemplate', () => {
  it('caches compiled templates and lists variables in order', () => {
    const t = 'A {{x}} {{#if y}}{{z | upper}}{{/if}} {{x}}';
    expect(compile(t)).toBe(compile(t));
    expect(compile(t).variables).toEqual(['x', 'y', 'z']);
  });

  it.each([
    ['{{x | nope}}', /unknown filter "nope"/],
    ['{{#if x}}open', /unclosed/],
    ['{{/if}}', /without/],
    ['{{else}}', /outside/],
    ['{{#if x}}a{{else}}b{{else}}c{{/if}}', /outside/],
    ['{{x | default:"oops}}', /unterminated quote/],
    ['{{}}', /invalid path/],
  ])('rejects %s', (template, message) => {
    const r = validateTemplate(template);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('accepts valid templates and returns their variables', () => {
    expect(validateTemplate('{{payload.notional | number:0}} {{$severity}}')).toEqual({
      ok: true,
      value: { variables: ['payload.notional', '$severity'] },
    });
  });
});
