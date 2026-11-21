import { toZonedTime } from 'date-fns-tz';
import type { WorkingHours } from './types.ts';

function parseHHMM(hhmm: string): { hours: number; minutes: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hours: h ?? 0, minutes: m ?? 0 };
}

export function isWorkingHours(user: WorkingHours, at: Date): boolean {
  const zoned = toZonedTime(at, user.timezone);
  const dayOfWeek = zoned.getDay() === 0 ? 7 : zoned.getDay(); // 1=Mon..7=Sun

  if (!user.days.includes(dayOfWeek)) return false;

  const start = parseHHMM(user.start);
  const end = parseHHMM(user.end);

  const currentMinutes = zoned.getHours() * 60 + zoned.getMinutes();
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}
