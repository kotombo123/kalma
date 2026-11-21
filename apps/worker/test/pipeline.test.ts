import { Alert, NormalizedEvent, SEED } from '@alerting/contracts';
import { describe, expect, it } from 'vitest';
import { processBatch } from '../src/pipeline.ts';
import { ALL_RULES, envelopes, loadRule, memoryDeps, PRICING_GROK } from './helpers.ts';

const rules = ALL_RULES.map(loadRule);

describe('processBatch', () => {
  it('500 identical workflow failures → 1 alert, count 500 (dedup)', async () => {
    const m = memoryDeps(rules);
    const one = envelopes('events/workflow-failed.json')[0]!;
    const stats = await processBatch(Array(500).fill(one), m.deps);

    expect(stats).toMatchObject({ events: 500, created: 1, deduplicated: 499, unmatched: 0 });
    expect(m.created).toHaveLength(1);
    const [alert] = m.created;
    expect(m.updates.get(alert!.id)?.count).toBe(500);
    expect(m.recent).toHaveLength(500);
  });

  it('builds the Team Settlements alert from the rule presentation', async () => {
    const m = memoryDeps(rules);
    await processBatch(envelopes('events/workflow-failed.json'), m.deps);
    const alert = Alert.parse(m.created[0]);
    expect(alert).toMatchObject({
      orgId: SEED.orgId,
      ruleId: 'rule-team-settlements',
      ruleVersion: 1,
      teamId: SEED.teams.settlements,
      sourceId: SEED.sources.http,
      groupKey: 'WF-20261023-00042', // dedup.keyTemplate {{workflowId}}
      status: 'open',
      severity: 'critical', // presentation.severity overrides the event's "error"
      title: 'order-settlement failed at validate-counterparty',
      body: 'TIMEOUT: Counterparty service did not respond in 5000 ms',
      count: 1,
      firstSeen: '2026-10-23T09:14:02.331Z',
    });
    expect(alert.fields).toEqual([
      { label: 'Step', value: 'validate-counterparty', highlight: 'red' },
      { label: 'Error', value: 'Counterparty service did not respond in 5000 ms', highlight: 'red' },
      { label: 'Workflow', value: 'WF-20261023-00042' },
    ]);
    expect(alert.lastEvent.flat['error.code']).toBe('TIMEOUT');
  });

  it('Team Rates and Anna alerts render their templates', async () => {
    const m = memoryDeps(rules);
    await processBatch(
      [...envelopes('events/trade-rejected.json'), ...envelopes('events/alertmanager-firing.json')],
      m.deps,
    );
    expect(m.created.map((a) => [a.ruleId, a.title])).toEqual([
      ['rule-team-rates', 'Rejected EUR 25000000 — LIMIT_BREACH'],
      ['rule-anna-payments-critical', 'HighErrorRate on payments-api (eu-west)'],
    ]);
    expect(m.created[0]!.fields).toContainEqual({
      label: 'Notional',
      value: '25,000,000 EUR',
      highlight: 'amber',
    });
  });

  it('grouping.by: Team Pricing makes one alert per instrument', async () => {
    const m = memoryDeps(rules);
    const stats = await processBatch(
      envelopes('events/pricing-engine.log', { parserOptions: { grokPattern: PRICING_GROK } }),
      m.deps,
    );
    // 4 lines: WARN EURUSD, WARN EURUSD, ERROR GBPUSD, INFO USDJPY (below WARN → unmatched)
    expect(stats).toMatchObject({ events: 4, created: 2, deduplicated: 1, unmatched: 1 });
    expect(m.created.map((a) => a.groupKey)).toEqual(['g:EURUSD', 'g:GBPUSD']);
    expect(m.created[0]!.title).toBe(
      'pricing-engine-3: EURUSD — quote latency 1240ms above threshold 1000ms',
    );
  });

  it('unknown schema: no rule matches, counted as unmatched, still in events:recent', async () => {
    const m = memoryDeps(rules);
    const stats = await processBatch(envelopes('events/judges-unknown.json'), m.deps);
    expect(stats).toMatchObject({ events: 1, created: 0, unmatched: 1 });
    const [schema] = [...m.schemas.values()];
    expect(schema).toMatchObject({ status: 'new', events: 1, unmatched: 1 });
    expect(NormalizedEvent.parse(m.recent[0])).toMatchObject({ severity: 'critical', entity: 'db-node-7' });
  });

  describe('auto-resolve (B1-14)', () => {
    const firing = () => envelopes('events/alertmanager-firing.json');
    const resolved = () => envelopes('events/alertmanager-resolved.json');

    it('Alertmanager firing → resolved closes the alert', async () => {
      const m = memoryDeps(rules);
      await processBatch(firing(), m.deps);
      const stats = await processBatch(resolved(), m.deps);
      expect(stats).toMatchObject({ created: 0, resolved: 1, resolvedSkipped: 0 });
      expect(m.created).toHaveLength(1);
      expect(m.created[0]).toMatchObject({
        ruleId: 'rule-anna-payments-critical',
        status: 'resolved',
        resolvedBy: 'system',
      });
    });

    it('works when firing and resolved arrive in one batch', async () => {
      const m = memoryDeps(rules);
      const stats = await processBatch([...firing(), ...resolved()], m.deps);
      expect(stats).toMatchObject({ created: 1, resolved: 1 });
      expect(m.created[0]!.status).toBe('resolved');
    });

    it('the next firing after resolved opens a new alert (dedup window released)', async () => {
      const m = memoryDeps(rules);
      await processBatch([...firing(), ...resolved()], m.deps);
      const stats = await processBatch(firing(), m.deps);
      expect(stats).toMatchObject({ created: 1, deduplicated: 0 });
      expect(m.created.map((a) => a.status)).toEqual(['resolved', 'open']);
    });

    it('a resolved event without an open alert never opens one', async () => {
      const m = memoryDeps(rules);
      const stats = await processBatch(resolved(), m.deps);
      expect(stats).toMatchObject({ created: 0, resolved: 0, resolvedSkipped: 1 });
      expect(m.created).toHaveLength(0);
    });

    it('autoResolve.onSourceResolved: false leaves the alert open', async () => {
      const off = rules.map((r) => ({
        ...r,
        autoResolve: { onSourceResolved: false, onRunbookSuccess: false },
      }));
      const m = memoryDeps(off);
      await processBatch(firing(), m.deps);
      const stats = await processBatch(resolved(), m.deps);
      expect(stats).toMatchObject({ resolved: 0, resolvedSkipped: 1 });
      expect(m.created[0]!.status).toBe('open');
    });
  });

  it('ignored schemas skip rule evaluation', async () => {
    const probe = memoryDeps(rules);
    await processBatch(envelopes('events/workflow-failed.json'), probe.deps);
    const [fp] = [...probe.schemas.keys()];
    const m = memoryDeps(rules, { ignored: [fp!] });
    const stats = await processBatch(envelopes('events/workflow-failed.json'), m.deps);
    expect(stats.created).toBe(0);
    expect(m.recent).toHaveLength(1);
  });

  it('skips invalid payloads without failing the batch', async () => {
    const m = memoryDeps(rules);
    const stats = await processBatch(
      ['not json', '{"id":1}', ...envelopes('events/workflow-failed.json')],
      m.deps,
    );
    expect(stats).toMatchObject({ invalid: 2, events: 1, created: 1 });
  });

  it('events of an org without rules are only recorded', async () => {
    const m = memoryDeps([]);
    const stats = await processBatch(envelopes('events/workflow-failed.json'), m.deps);
    expect(stats).toMatchObject({ events: 1, created: 0, unmatched: 1 });
  });

  it('reports ingest → worker and ingest → alert latency', async () => {
    const m = memoryDeps(rules);
    const seen: [string, number][] = [];
    await processBatch(envelopes('events/workflow-failed.json', { ingestTs: 1000 }), {
      ...m.deps,
      now: () => 1250,
      onLatency: (stage, ms) => seen.push([stage, ms]),
    });
    expect(seen).toEqual([
      ['ingest_to_worker', 250],
      ['ingest_to_alert', 250],
    ]);
  });
});
