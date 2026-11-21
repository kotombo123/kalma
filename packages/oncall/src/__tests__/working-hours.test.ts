import { describe, it, expect } from 'vitest';
import { isWorkingHours } from '../working-hours.ts';
import type { WorkingHours } from '../types.ts';

const ANNA_HOURS: WorkingHours = {
  days: [1, 2, 3, 4, 5], // Mon-Fri
  start: '08:00',
  end: '20:00',
  timezone: 'Europe/Warsaw',
};

describe('isWorkingHours', () => {
  it('returns true during work hours on weekday', () => {
    // 2026-11-23 is Monday, 10:00 Warsaw = 09:00 UTC
    const at = new Date('2026-11-23T09:00:00Z');
    expect(isWorkingHours(ANNA_HOURS, at)).toBe(true);
  });

  it('returns false before work hours', () => {
    // 06:00 Warsaw = 05:00 UTC
    const at = new Date('2026-11-23T05:00:00Z');
    expect(isWorkingHours(ANNA_HOURS, at)).toBe(false);
  });

  it('returns false after work hours', () => {
    // 21:00 Warsaw = 20:00 UTC
    const at = new Date('2026-11-23T20:00:00Z');
    expect(isWorkingHours(ANNA_HOURS, at)).toBe(false);
  });

  it('returns false on weekend', () => {
    // 2026-11-22 is Sunday
    const at = new Date('2026-11-22T10:00:00Z');
    expect(isWorkingHours(ANNA_HOURS, at)).toBe(false);
  });

  it('handles DST boundary correctly (Poland, Monday after spring switch)', () => {
    // Poland switches to CEST on last Sunday of March (2027-03-28, UTC+1→+2 at 01:00 UTC).
    // Monday 2027-03-29: now in CEST (UTC+2).
    // 07:00 UTC = 09:00 CEST → within 08:00-20:00
    const mondayAfterDST = new Date('2027-03-29T07:00:00Z');
    expect(isWorkingHours(ANNA_HOURS, mondayAfterDST)).toBe(true);

    // Friday 2027-03-26 (still CET=UTC+1): 07:30 UTC = 08:30 CET → within hours
    const fridayBeforeDST = new Date('2027-03-26T07:30:00Z');
    expect(isWorkingHours(ANNA_HOURS, fridayBeforeDST)).toBe(true);
  });

  it('returns false exactly at end time (20:00)', () => {
    // 20:00 Warsaw = 18:00 UTC (CEST), edge case — not working
    const at = new Date('2026-11-23T19:00:00Z'); // 20:00 Warsaw (CET = UTC+1)
    expect(isWorkingHours(ANNA_HOURS, at)).toBe(false);
  });
});
