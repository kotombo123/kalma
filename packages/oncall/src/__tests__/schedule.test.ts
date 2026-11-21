import { describe, it, expect } from 'vitest';
import { whoIsOnCall, nextEscalationTarget } from '../schedule.ts';
import type { OncallSchedule, OncallOverride } from '../types.ts';

const SCHEDULE_WEEKLY: OncallSchedule = {
  id: 'sch-1',
  teamId: 'team-settlements',
  rotation: 'weekly',
  handoffTime: '09:00',
  timezone: 'Europe/Warsaw',
  participants: ['user-anna', 'user-bob', 'user-carol'],
  startDate: '2026-11-03', // Mon week 1 → anna
};

const NO_OVERRIDES: OncallOverride[] = [];

describe('whoIsOnCall', () => {
  it('returns first participant in first week', () => {
    const at = new Date('2026-11-03T10:00:00Z');
    expect(whoIsOnCall(SCHEDULE_WEEKLY, NO_OVERRIDES, at).userId).toBe('user-anna');
  });

  it('rotates to second participant in second week', () => {
    const at = new Date('2026-11-10T10:00:00Z');
    expect(whoIsOnCall(SCHEDULE_WEEKLY, NO_OVERRIDES, at).userId).toBe('user-bob');
  });

  it('wraps around after all participants', () => {
    const at = new Date('2026-11-24T10:00:00Z'); // week 4 → back to anna
    expect(whoIsOnCall(SCHEDULE_WEEKLY, NO_OVERRIDES, at).userId).toBe('user-anna');
  });

  it('applies an active override', () => {
    const override: OncallOverride = {
      id: 'ov-1',
      scheduleId: 'sch-1',
      userId: 'user-substitute',
      startsAt: '2026-11-03T00:00:00Z',
      endsAt: '2026-11-04T00:00:00Z',
    };
    const at = new Date('2026-11-03T10:00:00Z');
    const result = whoIsOnCall(SCHEDULE_WEEKLY, [override], at);
    expect(result.userId).toBe('user-substitute');
    expect(result.overrideId).toBe('ov-1');
  });

  it('ignores expired override', () => {
    const override: OncallOverride = {
      id: 'ov-2',
      scheduleId: 'sch-1',
      userId: 'user-substitute',
      startsAt: '2026-11-01T00:00:00Z',
      endsAt: '2026-11-02T00:00:00Z',
    };
    const at = new Date('2026-11-03T10:00:00Z');
    expect(whoIsOnCall(SCHEDULE_WEEKLY, [override], at).userId).toBe('user-anna');
  });
});

describe('daily rotation', () => {
  const DAILY: OncallSchedule = {
    id: 'sch-2',
    teamId: 'team-pricing',
    rotation: 'daily',
    handoffTime: '08:00',
    timezone: 'UTC',
    participants: ['user-x', 'user-y'],
    startDate: '2026-11-21',
  };

  it('assigns day 0 to first participant', () => {
    const at = new Date('2026-11-21T10:00:00Z');
    expect(whoIsOnCall(DAILY, [], at).userId).toBe('user-x');
  });

  it('assigns day 1 to second participant', () => {
    const at = new Date('2026-11-22T10:00:00Z');
    expect(whoIsOnCall(DAILY, [], at).userId).toBe('user-y');
  });
});

describe('nextEscalationTarget', () => {
  it('returns next participant at level 1', () => {
    const at = new Date('2026-11-03T10:00:00Z'); // anna is on call
    const result = nextEscalationTarget(SCHEDULE_WEEKLY, NO_OVERRIDES, at, 1);
    expect(result?.userId).toBe('user-bob');
  });

  it('returns undefined when level exceeds participants', () => {
    const at = new Date('2026-11-03T10:00:00Z');
    expect(nextEscalationTarget(SCHEDULE_WEEKLY, NO_OVERRIDES, at, 10)).toBeUndefined();
  });
});
