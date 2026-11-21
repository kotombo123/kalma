import type { FieldRole, GuessedRoles } from '@alerting/contracts';
import { readFixture } from '@alerting/contracts/fixtures';
import { parse } from '@alerting/parsing';
import { describe, expect, it } from 'vitest';
import { flatten, guessRoles, MIN_CONFIDENCE, scoreRole } from '../src/index.ts';

const PRICING_GROK =
  '%{TIMESTAMP_ISO8601:ts} %{LOGLEVEL:level} \\[%{NOTSPACE:service}\\] %{WORD:instrument} %{GREEDYDATA:message}';

const rolesOf = (name: string) => {
  const parserOptions = name.endsWith('pricing-engine.log') ? { grokPattern: PRICING_GROK } : undefined;
  const { records } = parse({ body: readFixture(name), parserOptions });
  return guessRoles(flatten(records[0]));
};

const paths = (roles: GuessedRoles) =>
  Object.fromEntries(Object.entries(roles).map(([role, g]) => [role, g.path])) as Partial<
    Record<FieldRole, string>
  >;

describe('guessRoles on fixtures', () => {
  it.each<[string, Partial<Record<FieldRole, string>>]>([
    [
      'events/workflow-failed.json',
      {
        severity: 'severity',
        timestamp: 'timestamp',
        title: 'error.message',
        message: 'error.message',
        entity: 'workflowId',
        dedupKey: 'workflowId',
      },
    ],
    [
      'events/alertmanager-firing.json',
      {
        severity: 'labels.severity',
        timestamp: 'startsAt',
        title: 'annotations.summary',
        message: 'annotations.summary',
        status: 'status',
        entity: 'labels.service',
        dedupKey: 'alertname',
      },
    ],
    [
      'events/trade-rejected.json',
      {
        timestamp: 'meta.ts',
        title: 'payload.reason',
        message: 'payload.reason',
        entity: 'payload.tradeId',
        dedupKey: 'payload.tradeId',
      },
    ],
    [
      'events/judges-unknown.json',
      { severity: 'lvl', timestamp: 'when', title: 'evt', entity: 'host.name', dedupKey: 'incidentRef' },
    ],
    [
      'events/settlement-batch.xml',
      {
        severity: 'event.priority',
        timestamp: 'event.occurredAt',
        title: 'event.details.reason',
        message: 'event.details.reason',
        entity: 'event.batchId',
        dedupKey: 'event.batchId',
      },
    ],
    [
      'events/reconciliation.csv',
      { severity: 'level', timestamp: 'timestamp', title: 'message', message: 'message', entity: 'account' },
    ],
    [
      'events/logfmt.log',
      { severity: 'level', timestamp: 'ts', title: 'msg', message: 'msg', entity: 'service' },
    ],
    [
      'events/pricing-engine.log',
      { severity: 'level', timestamp: 'ts', title: 'message', message: 'message', entity: 'service' },
    ],
  ])('%s', (name, expected) => {
    const roles = rolesOf(name);
    expect(paths(roles)).toEqual(expected);
    for (const g of Object.values(roles)) {
      expect(g.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
      expect(g.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('resolved Alertmanager event also maps status', () => {
    expect(rolesOf('events/alertmanager-resolved.json').status).toEqual({ path: 'status', confidence: 1 });
  });

  it('is confident about well-known names with matching values', () => {
    const roles = rolesOf('events/alertmanager-firing.json');
    expect(roles.severity?.confidence).toBe(1);
    expect(roles.title?.confidence).toBe(1);
    expect(roles.entity?.confidence).toBe(1);
  });
});

describe('guessRoles heuristics', () => {
  it('guesses timestamp, severity and status from values when names say nothing', () => {
    const roles = guessRoles({ a: '2026-10-23T09:14:02Z', b: 'CRIT', c: 'resolved' });
    expect(paths(roles)).toMatchObject({ timestamp: 'a', severity: 'b', status: 'c' });
    expect(roles.timestamp!.confidence).toBeLessThan(0.6);
  });

  it('recognises epoch seconds and milliseconds', () => {
    expect(guessRoles({ when: 1792834000 }).timestamp?.path).toBe('when');
    expect(guessRoles({ x: 1792833245000 }).timestamp?.path).toBe('x');
    expect(guessRoles({ x: 42 }).timestamp).toBeUndefined();
  });

  it('distrusts a role name whose value contradicts it', () => {
    expect(scoreRole('timestamp', 'time', 'not a date')).toBeLessThan(MIN_CONFIDENCE);
    expect(scoreRole('severity', 'level', 'banana')).toBeLessThan(MIN_CONFIDENCE);
    expect(guessRoles({ time: 'later', ts: '2026-10-23T09:14:02Z' }).timestamp?.path).toBe('ts');
  });

  it('never uses per-message ids as entity or dedup key', () => {
    const roles = guessRoles({ request_id: 'req-7781', traceId: 'abc', orderId: 'O-1' });
    expect(roles.entity?.path).toBe('orderId');
    expect(roles.dedupKey?.path).toBe('orderId');
    expect(guessRoles({ request_id: 'req-1' }).dedupKey).toBeUndefined();
  });

  it('prefers summary over message for the title, and message over summary for the message', () => {
    const roles = guessRoles({ message: 'disk almost full on db-7', summary: 'Disk pressure on db-7' });
    expect(roles.title?.path).toBe('summary');
    expect(roles.message?.path).toBe('message');
  });

  it('reads array paths and keeps the concrete index', () => {
    const roles = guessRoles(
      flatten({ alerts: [{ labels: { severity: 'warning', service: 'rates-feed' } }] }),
    );
    expect(roles.severity?.path).toBe('alerts[0].labels.severity');
    expect(roles.entity?.path).toBe('alerts[0].labels.service');
  });

  it('returns nothing for an event with no recognisable fields', () => {
    expect(guessRoles({ foo: 1, bar: true })).toEqual({});
    expect(guessRoles({})).toEqual({});
  });
});
