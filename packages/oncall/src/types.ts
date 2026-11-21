import type { Severity, ChannelType } from '@alerting/contracts';

export type { ChannelType, Severity } from '@alerting/contracts';

export interface OncallSchedule {
  id: string;
  teamId: string;
  rotation: 'daily' | 'weekly';
  handoffTime: string; // HH:MM
  timezone: string;
  participants: string[]; // user IDs
  startDate: string; // ISO date
}

export interface OncallOverride {
  id: string;
  scheduleId: string;
  userId: string;
  startsAt: string; // ISO
  endsAt: string; // ISO
}

export interface WorkingHours {
  days: number[]; // 1=Mon..7=Sun
  start: string; // HH:MM
  end: string; // HH:MM
  timezone: string;
}

export interface ChannelPrefs {
  userId: string;
  severity: Severity;
  inHours: ChannelType[];
  offHours: ChannelType[];
}
