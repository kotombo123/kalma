/**
 * B2-11: Escalation loop — every 15s checks open alerts past next_escalation_at,
 * resolves next oncall target, inserts new deliveries, records timeline event.
 */
import type { Logger } from '@alerting/config';
import { newId } from '@alerting/config';
import { escalationsTotal } from './notifier-metrics.ts';
import { type Db, t, eq, and, lte, sql, alertFromRow } from '@alerting/db';
import { nextEscalationTarget, resolveChannels } from '@alerting/oncall';
import type { OncallSchedule, OncallOverride, WorkingHours } from '@alerting/oncall';
import type { Severity, ChannelType } from '@alerting/contracts';

const POLL_INTERVAL_MS = 15_000;
const MAX_ESCALATION_LEVEL = 3;

export async function runEscalationLoop(db: Db, log: Logger): Promise<void> {
  log.info('escalation loop started');
  while (true) {
    await checkEscalations(db, log);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function checkEscalations(db: Db, log: Logger): Promise<void> {
  const now = new Date();

  const dueAlerts = await db
    .select()
    .from(t.alerts)
    .where(
      and(
        eq(t.alerts.status, 'open'),
        lte(t.alerts.nextEscalationAt, now.toISOString()),
        sql`${t.alerts.nextEscalationAt} is not null`,
      ),
    )
    .limit(50)
    .for('update', { skipLocked: true });

  for (const alertRow of dueAlerts) {
    const alert = alertFromRow(alertRow);
    const currentLevel = alertRow.escalationLevel ?? 0;

    if (currentLevel >= MAX_ESCALATION_LEVEL) {
      // Stop escalating — clear next_escalation_at
      await db
        .update(t.alerts)
        .set({ nextEscalationAt: null })
        .where(eq(t.alerts.id, alert.id));
      continue;
    }

    const nextLevel = currentLevel + 1;

    const scheduleRows = await db.query.oncallSchedules.findMany({
      where: eq(t.oncallSchedules.teamId, alert.teamId),
    });

    const recipients = new Set<string>();
    for (const sched of scheduleRows) {
      const overrideRows = await db.query.oncallOverrides.findMany({
        where: eq(t.oncallOverrides.scheduleId, sched.id),
      });

      const schedule: OncallSchedule = {
        id: sched.id,
        teamId: sched.teamId,
        rotation: sched.rotation,
        handoffTime: sched.handoffTime,
        timezone: sched.timezone,
        participants: sched.participants,
        startDate: sched.startDate,
      };
      const overrides: OncallOverride[] = overrideRows.map((o) => ({
        id: o.id,
        scheduleId: o.scheduleId,
        userId: o.userId,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
      }));

      const result = nextEscalationTarget(schedule, overrides, now, nextLevel);
      if (result) recipients.add(result.userId);
    }

    if (recipients.size === 0) {
      log.warn({ alertId: alert.id, level: nextLevel }, 'no escalation target');
    }

    for (const userId of Array.from(recipients)) {
      const channelPrefRows = await db.query.channelPrefs.findMany({
        where: eq(t.channelPrefs.userId, userId),
      });
      const channelAddrRows = await db.query.channelAddresses.findMany({
        where: eq(t.channelAddresses.userId, userId),
      });
      const userRow = await db.query.users.findFirst({
        where: eq(t.users.id, userId),
      });

      const DEFAULT_WH = { days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00', timezone: 'Europe/Warsaw' };
      const workingHours = (userRow?.workingHours ?? DEFAULT_WH) as WorkingHours;

      const prefs = channelPrefRows.map((p) => ({
        userId: p.userId,
        severity: p.severity as Severity,
        inHours: p.inHours as ChannelType[],
        offHours: p.offHours as ChannelType[],
      }));

      const channels = resolveChannels(prefs, userId, alert.severity, workingHours, now);

      for (const channel of channels) {
        const address =
          channel === 'ui'
            ? `ui:${alert.orgId}`
            : channelAddrRows.find((a) => a.channel === channel)?.address;

        if (!address) continue;

        await db
          .insert(t.deliveries)
          .values({
            id: newId(),
            alertId: alert.id,
            userId,
            channel: channel as typeof t.deliveries.$inferInsert['channel'],
            address,
            payload: { escalationLevel: nextLevel },
            status: 'pending' as const,
            attempts: 0,
            nextAttemptAt: now.toISOString(),
          })
          .onConflictDoNothing();
      }
    }

    // Calculate next escalation time (rule definition carries afterMin)
    const ruleRow = await db.query.rules.findFirst({ where: eq(t.rules.id, alert.ruleId) });
    const afterMin = ruleRow?.definition?.routing?.escalation?.afterMin ?? 30;
    const nextEscalationAt = new Date(now.getTime() + afterMin * 60_000).toISOString();

    await db
      .update(t.alerts)
      .set({ escalationLevel: nextLevel, nextEscalationAt })
      .where(eq(t.alerts.id, alert.id));

    await db.insert(t.alertTimeline).values({
      id: newId(),
      alertId: alert.id,
      ts: now.toISOString(),
      actorType: 'system',
      kind: 'escalation',
      data: { level: nextLevel, recipients: Array.from(recipients) },
    });

    escalationsTotal.inc({ level: String(nextLevel) });
    log.info({ alertId: alert.id, level: nextLevel, recipients: recipients.size }, 'escalated');
  }
}
