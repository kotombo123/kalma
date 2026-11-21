import { describe, expect, it } from 'vitest';
import { readJsonFixture } from '@alerting/contracts/fixtures';
import { alertFromRow } from '../src/mappers.ts';
import type { alerts } from '../src/schema.ts';

describe('alertFromRow', () => {
  it('turns a row with null columns into a valid Alert', () => {
    const sample = readJsonFixture<Record<string, unknown>>('alert.sample.json');
    const row = {
      ...sample,
      color: null,
      body: null,
      groupMembers: null,
      runbookInstanceId: null,
      ackBy: null,
      ackAt: null,
      resolvedBy: null,
      resolvedAt: null,
      dispatchedAt: null,
      escalationLevel: 0,
      nextEscalationAt: '2026-10-23T09:20:00Z',
    } as unknown as typeof alerts.$inferSelect;
    const alert = alertFromRow(row);
    expect(alert.id).toBe(sample.id);
    expect(alert).not.toHaveProperty('color');
    expect(alert).not.toHaveProperty('dispatchedAt');
    expect(alert).not.toHaveProperty('nextEscalationAt');
    expect(alert.escalationLevel).toBe(0);
  });
});
