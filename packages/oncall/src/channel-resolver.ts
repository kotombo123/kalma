import type { ChannelPrefs, ChannelType, Severity, WorkingHours } from './types.ts';
import { isWorkingHours } from './working-hours.ts';

export function resolveChannels(
  prefs: ChannelPrefs[],
  userId: string,
  severity: Severity,
  workingHours: WorkingHours,
  at: Date,
  ruleChannels?: ChannelType[],
): ChannelType[] {
  if (ruleChannels && ruleChannels.length > 0) return ruleChannels;

  const userPref = prefs.find((p) => p.userId === userId && p.severity === severity);
  if (!userPref) return ['ui', 'email'];

  const inWork = isWorkingHours(workingHours, at);
  return inWork ? userPref.inHours : userPref.offHours;
}
