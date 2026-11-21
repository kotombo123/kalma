import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Alert, RuleFile, UiEvent, Condition } from '../src/index.ts';
import { listFixtures, readFixture, readJsonFixture } from '../src/fixtures.ts';

describe('fixtures match contracts', () => {
  it('alert.sample.json is a valid Alert', () => {
    expect(() => Alert.parse(readJsonFixture('alert.sample.json'))).not.toThrow();
  });

  it.each(listFixtures('rules'))('rule %s is a valid RuleFile', (f) => {
    const r = RuleFile.safeParse(parse(readFixture(`rules/${f}`)));
    expect(r.error?.issues ?? []).toEqual([]);
  });

  it('UiEvent accepts alert.created', () => {
    expect(UiEvent.parse({ type: 'alert.created', alert: readJsonFixture('alert.sample.json') }).type).toBe(
      'alert.created',
    );
  });

  it('Condition rejects unknown ops', () => {
    expect(Condition.safeParse({ field: 'x', op: 'like', value: 1 }).success).toBe(false);
    expect(Condition.safeParse({ all: [{ not: { field: 'x', op: 'exists' } }] }).success).toBe(true);
  });
});
