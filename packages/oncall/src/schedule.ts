import { differenceInDays, differenceInWeeks, parseISO } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import type { OncallSchedule, OncallOverride } from './types.ts';

export interface OnCallResult {
  userId: string;
  overrideId?: string;
}

export function whoIsOnCall(
  schedule: OncallSchedule,
  overrides: OncallOverride[],
  at: Date,
): OnCallResult {
  const activeOverride = overrides.find((o) => {
    const start = parseISO(o.startsAt);
    const end = parseISO(o.endsAt);
    return at >= start && at < end && o.scheduleId === schedule.id;
  });

  if (activeOverride) {
    return { userId: activeOverride.userId, overrideId: activeOverride.id };
  }

  const startDate = parseISO(schedule.startDate);
  const tzStart = toZonedTime(startDate, schedule.timezone);
  const tzAt = toZonedTime(at, schedule.timezone);

  let index: number;
  if (schedule.rotation === 'daily') {
    const days = differenceInDays(tzAt, tzStart);
    index = Math.max(0, days) % schedule.participants.length;
  } else {
    const weeks = differenceInWeeks(tzAt, tzStart);
    index = Math.max(0, weeks) % schedule.participants.length;
  }

  const userId = schedule.participants[index];
  if (!userId) throw new Error(`Schedule ${schedule.id} has no participants`);

  return { userId };
}

export function nextEscalationTarget(
  schedule: OncallSchedule,
  overrides: OncallOverride[],
  at: Date,
  currentLevel: number,
): OnCallResult | undefined {
  const participants = schedule.participants;
  if (currentLevel >= participants.length) return undefined;

  const current = whoIsOnCall(schedule, overrides, at);
  const currentIdx = participants.indexOf(current.userId);

  const nextIdx = (currentIdx + currentLevel) % participants.length;
  const userId = participants[nextIdx];
  if (!userId) return undefined;

  return { userId };
}
