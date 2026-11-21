import { z } from 'zod';
import { ChannelType, Id, Severity } from './common.ts';

export const WorkingHours = z.object({
  /** ISO weekday 1 (Mon) … 7 (Sun) */
  days: z.array(z.number().int().min(1).max(7)),
  /** "HH:MM" in the user's timezone */
  start: z.string(),
  end: z.string(),
});
export type WorkingHours = z.infer<typeof WorkingHours>;

export const OrgRole = z.enum(['admin', 'member']);
export const TeamRole = z.enum(['lead', 'member']);

export const User = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  timezone: z.string().default('Europe/Warsaw'),
  workingHours: WorkingHours.optional(),
});
export type User = z.infer<typeof User>;

export const ChannelPref = z.object({
  severity: Severity,
  inHours: z.array(ChannelType),
  offHours: z.array(ChannelType),
});
export type ChannelPref = z.infer<typeof ChannelPref>;

export const OncallSchedule = z.object({
  id: Id,
  teamId: Id,
  rotation: z.enum(['daily', 'weekly']),
  /** "HH:MM" in schedule timezone */
  handoffTime: z.string(),
  timezone: z.string(),
  participants: z.array(Id),
  /** YYYY-MM-DD — first participant starts here */
  startDate: z.string(),
});
export type OncallSchedule = z.infer<typeof OncallSchedule>;

export const OncallOverride = z.object({
  id: Id,
  scheduleId: Id,
  userId: Id,
  startsAt: z.string(),
  endsAt: z.string(),
});
export type OncallOverride = z.infer<typeof OncallOverride>;
