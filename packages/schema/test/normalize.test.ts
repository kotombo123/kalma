import { NormalizedEvent, SEED, type Mapping } from '@alerting/contracts';
import { readFixture, readJsonFixture } from '@alerting/contracts/fixtures';
import { parse } from '@alerting/parsing';
import { describe, expect, it } from 'vitest';
import {
  defaultDedupKey,
  fingerprint,
  flatten,
  normalize,
  normalizeFlat,
  normalizeSeverity,
  normalizeStatus,
  normalizeTimestamp,
} from '../src/index.ts';

const RECEIVED_AT = '2026-10-23T09:30:00.000Z';

/** The worker's pipeline in miniature: raw → flatten → fingerprint → normalize. */
function pipeline(raw: unknown, mapping?: Parameters<typeof normalize>[0]['mapping']) {
  const flat = flatten(raw);
  const event = normalize({
    envelope: {
      id: '01JAPPENDIXA0000000000000',
      orgId: SEED.orgId,
      sourceId: SEED.sources.http,
      ingestTs: 1792834200000,
      receivedAt: RECEIVED_AT,
      raw,
    },
    schemaId: SEED.schemas.workflowFailed,
    fingerprint: fingerprint(flat),
    flat,
    mapping,
  });
  NormalizedEvent.parse(event); // always a valid contract object
  return event;
}

const fixture = (name: string) => {
  const { records } = parse({ body: readFixture(name) });
  return records[0];
};

describe('normalize — Appendix A, no mapping yet (guessed roles)', () => {
  it('workflow failure', () => {
    const e = pipeline(readJsonFixture('events/workflow-failed.json'));
    expect(e).toMatchObject({
      severity: 'error',
      timestamp: '2026-10-23T09:14:02.331Z',
      title: 'Counterparty service did not respond in 5000 ms',
      message: 'Counterparty service did not respond in 5000 ms',
      entity: 'WF-20261023-00042',
      dedupKey: 'WF-20261023-00042',
      status: 'firing',
    });
    expect(e.flat['error.code']).toBe('TIMEOUT');
  });

  it('Alertmanager firing and resolved', () => {
    const firing = pipeline(readJsonFixture('events/alertmanager-firing.json'));
    expect(firing).toMatchObject({
      severity: 'critical',
      timestamp: '2026-10-23T09:13:00.000Z',
      title: 'Error rate 12% over the last 5 minutes',
      entity: 'payments-api',
      dedupKey: 'HighErrorRate',
      status: 'firing',
    });
    const resolved = pipeline(readJsonFixture('events/alertmanager-resolved.json'));
    expect(resolved).toMatchObject({ status: 'resolved', dedupKey: 'HighErrorRate', entity: 'payments-api' });
  });

  it('business event with meta/payload envelope and epoch ms', () => {
    const e = pipeline(readJsonFixture('events/trade-rejected.json'));
    expect(e).toMatchObject({
      severity: 'info', // no severity field
      timestamp: new Date(1792833245000).toISOString(),
      title: 'LIMIT_BREACH',
      entity: 'T-998877',
      dedupKey: 'T-998877',
      status: 'firing',
    });
    expect(e.flat['payload.notional']).toBe(25000000);
  });

  it('unknown "judges" schema with epoch seconds', () => {
    const e = pipeline(readJsonFixture('events/judges-unknown.json'));
    expect(e).toMatchObject({
      severity: 'critical',
      timestamp: new Date(1792834000 * 1000).toISOString(),
      title: 'disk.pressure',
      entity: 'db-node-7',
      dedupKey: 'INC-55120',
    });
  });

  it('XML: priority HIGH → error, numeric strings → numbers', () => {
    const e = pipeline(fixture('events/settlement-batch.xml'));
    expect(e).toMatchObject({
      severity: 'error',
      timestamp: '2026-10-23T09:20:00.000Z',
      title: 'Ledger unavailable',
      entity: 'SB-20261023-07',
    });
    expect(e.flat['event.details.failedCount']).toBe(14);
  });

  it('CSV: CRIT → critical, numbers parsed, dedupKey defaulted', () => {
    const { records } = parse({ body: readFixture('events/reconciliation.csv') });
    const e = pipeline(records[1]);
    expect(e).toMatchObject({ severity: 'critical', entity: 'ACC-2002', title: 'Account balance missing' });
    expect(e.flat).toMatchObject({ expected: 900000, actual: 0 });
    expect(e.dedupKey).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('normalize — with a mapping', () => {
  const tradeMapping: Pick<Mapping, 'roles' | 'severityMap' | 'resolvedValues'> = {
    roles: {
      title: { template: 'Rejected {{payload.currency}} {{payload.notional}} — {{payload.reason}}' },
      timestamp: { path: 'meta.ts' },
      entity: { path: 'payload.desk' },
      severity: { path: 'payload.reason' },
    },
    severityMap: { LIMIT_BREACH: 'warning' },
  };

  it('uses paths, templates and severityMap; unmapped roles are not guessed', () => {
    const e = pipeline(readJsonFixture('events/trade-rejected.json'), tradeMapping);
    expect(e).toMatchObject({
      title: 'Rejected EUR 25000000 — LIMIT_BREACH',
      entity: 'rates',
      severity: 'warning',
      timestamp: new Date(1792833245000).toISOString(),
    });
    expect(e.message).toBeUndefined();
    expect(e.dedupKey).toBe(defaultDedupKey(e.fingerprint, 'rates', e.title));
  });

  it('custom resolvedValues replace the defaults', () => {
    const raw = { state: 'CLEARED', check: 'disk' };
    const roles = { status: { path: 'state' } };
    expect(pipeline(raw, { roles }).status).toBe('firing');
    expect(pipeline(raw, { roles, resolvedValues: ['CLEARED'] }).status).toBe('resolved');
  });

  it('falls back to receivedAt when the timestamp is missing or unreadable', () => {
    expect(pipeline({ when: 'yesterday' }, { roles: { timestamp: { path: 'when' } } }).timestamp).toBe(
      RECEIVED_AT,
    );
    expect(pipeline({ x: 1 }, { roles: {} }).timestamp).toBe(RECEIVED_AT);
  });
});

describe('normalizeSeverity', () => {
  it.each([
    ['CRIT', 'critical'],
    ['Fatal', 'critical'],
    ['ERROR', 'error'],
    ['HIGH', 'error'],
    ['warn', 'warning'],
    ['P3', 'warning'],
    ['INFO', 'info'],
    ['debug', 'info'],
    [2, 'critical'],
    [4, 'warning'],
    ['banana', 'info'],
    [null, 'info'],
    [undefined, 'info'],
  ] as const)('%s → %s', (input, expected) => {
    expect(normalizeSeverity(input)).toBe(expected);
  });

  it('severityMap wins over the defaults, exact or lower-case key', () => {
    expect(normalizeSeverity('ERROR', { ERROR: 'critical' })).toBe('critical');
    expect(normalizeSeverity('Sev1', { sev1: 'critical' })).toBe('critical');
  });
});

describe('normalizeTimestamp', () => {
  it.each([
    ['2026-10-23T09:14:02.331Z', '2026-10-23T09:14:02.331Z'],
    ['2026-10-23T11:14:02+02:00', '2026-10-23T09:14:02.000Z'],
    ['2026-10-23', '2026-10-23T00:00:00.000Z'],
    ['Fri, 23 Oct 2026 09:14:02 GMT', '2026-10-23T09:14:02.000Z'],
    [1792834000, new Date(1792834000000).toISOString()],
    [1792833245000, new Date(1792833245000).toISOString()],
    ['1792834000', new Date(1792834000000).toISOString()],
  ] as const)('%s → %s', (input, expected) => {
    expect(normalizeTimestamp(input)).toBe(expected);
  });

  it.each([['later'], ['1'], [42], [true], [null], ['2026-13-45']] as const)('%s → undefined', (input) => {
    expect(normalizeTimestamp(input)).toBeUndefined();
  });
});

describe('normalizeStatus', () => {
  it('maps default resolved values case-insensitively', () => {
    expect(normalizeStatus('RESOLVED')).toBe('resolved');
    expect(normalizeStatus('ok')).toBe('resolved');
    expect(normalizeStatus('firing')).toBe('firing');
    expect(normalizeStatus(undefined)).toBe('firing');
  });
});

describe('normalizeFlat', () => {
  it('turns plain numeric strings into numbers, keeps ids and codes as strings', () => {
    expect(
      normalizeFlat({
        a: '1500000',
        b: '-3.25',
        c: '0',
        id: '007',
        big: '12345678901234567890',
        exp: '1e5',
        code: 'E_TIMEOUT',
        n: 5,
        z: null,
      }),
    ).toEqual({
      a: 1500000,
      b: -3.25,
      c: 0,
      id: '007',
      big: '12345678901234567890',
      exp: '1e5',
      code: 'E_TIMEOUT',
      n: 5,
      z: null,
    });
  });
});

describe('defaultDedupKey', () => {
  it('is stable for the same fingerprint, entity and title, and differs otherwise', () => {
    expect(defaultDedupKey('fp', 'svc', 'Down')).toBe(defaultDedupKey('fp', 'svc', 'Down'));
    expect(defaultDedupKey('fp', 'svc', 'Down')).not.toBe(defaultDedupKey('fp', 'svc2', 'Down'));
  });
});
