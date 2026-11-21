import { NormalizedEvent, SEED } from '@alerting/contracts';
import { readFixture, readJsonFixture } from '@alerting/contracts/fixtures';
import { parse } from '@alerting/parsing';
import { describe, expect, it } from 'vitest';
import { detectPreset, fingerprint, flatten, matchPresets, normalize, PRESETS } from '../src/index.ts';

const PRICING_GROK =
  '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} \\[%{NOTSPACE:service}\\] %{WORD:instrument} %{GREEDYDATA:message}';

/** What the worker will do for a new schema: detect a preset, normalize with its mapping. */
function auto(raw: unknown) {
  const flat = flatten(raw);
  const detected = detectPreset(flat);
  const event = normalize({
    envelope: {
      id: '01JPRESET00000000000000000',
      orgId: SEED.orgId,
      sourceId: SEED.sources.http,
      ingestTs: 1792834200000,
      receivedAt: '2026-10-23T09:30:00.000Z',
      raw,
    },
    schemaId: SEED.schemas.workflowFailed,
    fingerprint: fingerprint(flat),
    flat,
    mapping: detected?.mapping,
  });
  NormalizedEvent.parse(event);
  return { presetId: detected?.preset.id, mapping: detected?.mapping, event };
}

const parsed = (name: string, grokPattern?: string) =>
  parse({ body: readFixture(name), parserOptions: grokPattern ? { grokPattern } : undefined }).records[0];

describe('presets on fixtures', () => {
  it('Alertmanager (Appendix A) maps automatically, firing and resolved alike', () => {
    const firing = auto(readJsonFixture('events/alertmanager-firing.json'));
    expect(firing.presetId).toBe('alertmanager');
    expect(firing.mapping).toEqual({
      presetId: 'alertmanager',
      roles: {
        severity: { path: 'labels.severity' },
        timestamp: { path: 'startsAt' },
        title: { path: 'annotations.summary' },
        message: { path: 'annotations.summary' },
        status: { path: 'status' },
        entity: { path: 'labels.service' },
        dedupKey: { path: 'alertname' },
      },
      severityMap: undefined,
      resolvedValues: ['resolved'],
    });
    expect(firing.event).toMatchObject({
      severity: 'critical',
      status: 'firing',
      title: 'Error rate 12% over the last 5 minutes',
      entity: 'payments-api',
      dedupKey: 'HighErrorRate',
      timestamp: '2026-10-23T09:13:00.000Z',
    });

    const resolved = auto(readJsonFixture('events/alertmanager-resolved.json'));
    expect(resolved.presetId).toBe('alertmanager');
    expect(resolved.event).toMatchObject({ status: 'resolved', dedupKey: 'HighErrorRate' });
    // different fingerprints (endsAt), same mapping → the resolved event closes the firing alert
    expect(resolved.event.fingerprint).not.toBe(firing.event.fingerprint);
    expect(resolved.mapping?.roles).toEqual(firing.mapping?.roles);
  });

  it('workflow failure → workflow-event', () => {
    const { presetId, event } = auto(readJsonFixture('events/workflow-failed.json'));
    expect(presetId).toBe('workflow-event');
    expect(event).toMatchObject({
      severity: 'error',
      entity: 'WF-20261023-00042',
      dedupKey: 'WF-20261023-00042',
      title: 'Counterparty service did not respond in 5000 ms',
      status: 'firing', // no status field in the event
    });
  });

  it('trade rejected → meta-payload', () => {
    const { presetId, event } = auto(readJsonFixture('events/trade-rejected.json'));
    expect(presetId).toBe('meta-payload');
    expect(event).toMatchObject({
      title: 'LIMIT_BREACH',
      entity: 'T-998877',
      timestamp: new Date(1792833245000).toISOString(),
    });
  });

  it('logfmt and grok log lines → structured-log', () => {
    expect(auto(parsed('events/logfmt.log')).event).toMatchObject({
      severity: 'error',
      title: 'upstream timeout',
      entity: 'counterparty-service',
      timestamp: '2026-10-23T09:16:00.000Z',
    });
    expect(auto(parsed('events/logfmt.log')).presetId).toBe('structured-log');
    const pricing = auto(parsed('events/pricing-engine.log', PRICING_GROK));
    expect(pricing.presetId).toBe('structured-log');
    expect(pricing.event).toMatchObject({ severity: 'warning', entity: 'pricing-engine-3' });
  });

  it('the unknown "judges" schema matches no preset (falls back to guessed roles)', () => {
    const { presetId, event } = auto(readJsonFixture('events/judges-unknown.json'));
    expect(presetId).toBeUndefined();
    expect(event).toMatchObject({ severity: 'critical', entity: 'db-node-7', dedupKey: 'INC-55120' });
  });
});

describe('presets on well-known payloads', () => {
  it('Alertmanager grouped webhook', () => {
    const { presetId, event } = auto({
      version: '4',
      groupKey: '{}:{alertname="HighLatency"}',
      status: 'resolved',
      receiver: 'alerting',
      commonLabels: { alertname: 'HighLatency' },
      alerts: [
        {
          status: 'resolved',
          labels: { alertname: 'HighLatency', service: 'rates-feed', severity: 'warning' },
          annotations: { summary: 'p99 above 2s' },
          startsAt: '2026-10-23T09:00:00Z',
        },
      ],
    });
    expect(presetId).toBe('alertmanager-webhook');
    expect(event).toMatchObject({
      severity: 'warning',
      status: 'resolved',
      title: 'p99 above 2s',
      entity: 'rates-feed',
      dedupKey: '{}:{alertname="HighLatency"}',
    });
  });

  it('CloudEvents', () => {
    const { presetId, event } = auto({
      specversion: '1.0',
      id: 'ce-1',
      source: '/payments/api',
      type: 'com.acme.payment.failed',
      subject: 'PAY-42',
      time: '2026-10-23T09:10:00Z',
      data: { severity: 'error', message: 'Card processor timeout' },
    });
    expect(presetId).toBe('cloudevents');
    expect(event).toMatchObject({
      severity: 'error',
      title: 'Card processor timeout',
      entity: 'PAY-42',
      dedupKey: '/payments/api:com.acme.payment.failed:PAY-42',
      timestamp: '2026-10-23T09:10:00.000Z',
    });
  });

  it('Sentry event alert', () => {
    const { presetId, event } = auto({
      action: 'triggered',
      data: {
        event: {
          title: "TypeError: Cannot read properties of undefined (reading 'id')",
          level: 'error',
          culprit: 'app/checkout.ts in submitOrder',
          project: 'web-checkout',
          issue_id: '4512',
          timestamp: 1792833000.123,
        },
        triggered_rule: 'New issue',
      },
    });
    expect(presetId).toBe('sentry');
    expect(event).toMatchObject({
      severity: 'error',
      status: 'firing',
      entity: 'web-checkout',
      dedupKey: '4512',
      message: 'app/checkout.ts in submitOrder',
      timestamp: new Date(1792833000123).toISOString(),
    });
  });

  it('GitHub workflow_run: failure fires, success resolves', () => {
    const run = (conclusion: string) => ({
      action: 'completed',
      workflow_run: {
        id: 9001,
        name: 'deploy',
        head_branch: 'main',
        conclusion,
        html_url: 'https://github.example/acme/payments/actions/runs/9001',
        updated_at: '2026-10-23T09:05:00Z',
      },
      repository: { full_name: 'acme/payments' },
    });
    const failed = auto(run('failure'));
    expect(failed.presetId).toBe('github-workflow-run');
    expect(failed.event).toMatchObject({
      severity: 'error',
      status: 'firing',
      title: 'Workflow deploy failure on main',
      entity: 'acme/payments',
      dedupKey: 'acme/payments:deploy:main',
    });
    const fixed = auto(run('success'));
    expect(fixed.event).toMatchObject({
      severity: 'info',
      status: 'resolved',
      dedupKey: 'acme/payments:deploy:main',
    });
  });
});

describe('matchPresets', () => {
  it('ranks specific presets above generic ones', () => {
    const flat = flatten({ workflowId: 'WF-1', type: 'WORKFLOW_FAILED', level: 'error', message: 'boom' });
    expect(matchPresets(flat).map((p) => p.id)).toEqual(['workflow-event', 'structured-log']);
  });

  it('has unique preset ids', () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it('drops roles whose fields are absent', () => {
    const detected = detectPreset(flatten({ level: 'warn', msg: 'slow' }));
    expect(detected?.mapping.roles).toEqual({
      severity: { path: 'level' },
      title: { path: 'msg' },
      message: { path: 'msg' },
    });
  });
});
