/**
 * B2-05: For each alert from stream:alerts —
 *   1. Fetch alert + rule from DB.
 *   2. Find matching runbook (by rule.definition.runbookId), fill templates → insert runbook_instance.
 *   3. Resolve recipients (oncall + channel prefs).
 *   4. Idempotently insert delivery rows.
 *   5. Set dispatched_at + next_escalation_at on alert.
 */
import type { Logger } from '@alerting/config';
import { newId, uiChannel } from '@alerting/config';
import type { Redis } from '@alerting/config';
import type { AlertStreamMessage } from '@alerting/contracts';
import { type Db, t, eq, and, isNull, inArray, alertFromRow } from '@alerting/db';
import { fillRunbook } from '@alerting/runbooks';
import { parseYaml } from '@alerting/runbooks';
import { parseMarkdown } from '@alerting/runbooks';
import { parseChecklist } from '@alerting/runbooks';
import { parseText } from '@alerting/runbooks';
import { whoIsOnCall } from '@alerting/oncall';
import { resolveChannels } from '@alerting/oncall';
import type { OncallSchedule, OncallOverride, WorkingHours } from '@alerting/oncall';
import type { Severity, ChannelType } from '@alerting/contracts';

function simpleRender(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const k = key.trim().split('|')[0]?.trim() ?? key.trim();
    return String(data[k] ?? '');
  });
}

function parseSource(format: string, source: string) {
  if (format === 'yaml') return parseYaml(source);
  if (format === 'markdown') return parseMarkdown(source);
  if (format === 'checklist') return parseChecklist(source);
  return parseText(source);
}

import { checkThrottle } from './throttle.ts';

export async function dispatchAlert(
  db: Db,
  redis: Redis,
  log: Logger,
  msg: AlertStreamMessage,
): Promise<void> {
  const { alertId } = msg;

  // --- 1. Fetch alert ---
  const alertRow = await db.query.alerts.findFirst({ where: eq(t.alerts.id, alertId) });
  if (!alertRow) {
    log.warn({ alertId }, 'alert not found, skipping');
    return;
  }
  if (alertRow.dispatchedAt) {
    log.debug({ alertId }, 'already dispatched');
    return;
  }

  const alert = alertFromRow(alertRow);

  // --- 2. Fetch rule ---
  const ruleRow = await db.query.rules.findFirst({ where: eq(t.rules.id, alert.ruleId) });
  const ruleDef = ruleRow?.definition;
  const escalationAfterMin: number = ruleDef?.routing?.escalation?.afterMin ?? 30;
  const ruleRunbookId = ruleDef?.runbookId;

  // --- 3. Find + fill runbook ---
  let runbookInstanceId: string | undefined;

  const runbookRow = ruleRunbookId
    ? await db.query.runbooks.findFirst({ where: eq(t.runbooks.id, ruleRunbookId) })
    : await db.query.runbooks.findFirst({ where: eq(t.runbooks.orgId, alert.orgId) });

  if (runbookRow) {
    const parsed = parseSource(runbookRow.format, runbookRow.source);
    const alertData: Record<string, unknown> = {
      alertId: alert.id,
      orgId: alert.orgId,
      ruleId: alert.ruleId,
      title: alert.title,
      severity: alert.severity,
      ...Object.fromEntries(alert.fields.map((f) => [f.label, f.value])),
      ...((alert.lastEvent?.flat as Record<string, unknown>) ?? {}),
    };

    const filled = fillRunbook(parsed.steps, alertData, { renderTemplate: simpleRender });
    runbookInstanceId = newId();

    await db
      .insert(t.runbookInstances)
      .values({
        id: runbookInstanceId,
        alertId: alert.id,
        runbookId: runbookRow.id,
        runbookVersion: runbookRow.version,
        steps: filled.map((s) => ({
          ...s,
          state: 'pending' as const,
          missing: s.missingFields,
          attempts: 0,
        })),
      })
      .onConflictDoNothing();

    await db
      .update(t.alerts)
      .set({ runbookInstanceId })
      .where(eq(t.alerts.id, alertId));

    log.info({ alertId, runbookId: runbookRow.id }, 'runbook instance created');
  }

  // --- 4. Resolve recipients ---
  const scheduleRows = await db.query.oncallSchedules.findMany({
    where: eq(t.oncallSchedules.teamId, alert.teamId),
  });

  const overrideRows =
    scheduleRows.length > 0
      ? await db.query.oncallOverrides.findMany({
          where: inArray(
            t.oncallOverrides.scheduleId,
            scheduleRows.map((s) => s.id),
          ),
        })
      : [];

  const now = new Date();
  const recipients = new Set<string>();

  for (const sched of scheduleRows) {
    const schedule: OncallSchedule = {
      id: sched.id,
      teamId: sched.teamId,
      rotation: sched.rotation,
      handoffTime: sched.handoffTime,
      timezone: sched.timezone,
      participants: sched.participants,
      startDate: sched.startDate,
    };
    const overrides: OncallOverride[] = overrideRows
      .filter((o) => o.scheduleId === sched.id)
      .map((o) => ({
        id: o.id,
        scheduleId: o.scheduleId,
        userId: o.userId,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
      }));

    const result = whoIsOnCall(schedule, overrides, now);
    if (result) recipients.add(result.userId);
  }

  // Fallback to all team members
  if (recipients.size === 0) {
    const members = await db.query.teamMembers.findMany({
      where: eq(t.teamMembers.teamId, alert.teamId),
    });
    for (const m of members) recipients.add(m.userId);
  }

  // --- 5. Build deliveries ---
  const userIds = Array.from(recipients);
  if (userIds.length === 0) {
    log.warn({ alertId, teamId: alert.teamId }, 'no recipients found');
  }

  const channelPrefRows =
    userIds.length > 0
      ? await db.query.channelPrefs.findMany({
          where: inArray(t.channelPrefs.userId, userIds),
        })
      : [];

  const channelAddrRows =
    userIds.length > 0
      ? await db.query.channelAddresses.findMany({
          where: inArray(t.channelAddresses.userId, userIds),
        })
      : [];

  const userRows =
    userIds.length > 0
      ? await db.query.users.findMany({
          where: inArray(t.users.id, userIds),
        })
      : [];

  const deliveryValues: (typeof t.deliveries.$inferInsert)[] = [];

  for (const userId of userIds) {
    const user = userRows.find((u) => u.id === userId);
    const DEFAULT_WH = { days: [1, 2, 3, 4, 5], start: '08:00', end: '20:00', timezone: user?.timezone ?? 'Europe/Warsaw' };
    const workingHours = (user?.workingHours ?? DEFAULT_WH) as WorkingHours;

    const prefs = channelPrefRows
      .filter((p) => p.userId === userId)
      .map((p) => ({
        userId: p.userId,
        severity: p.severity as Severity,
        inHours: p.inHours as ChannelType[],
        offHours: p.offHours as ChannelType[],
      }));

    const channels = resolveChannels(prefs, userId, alert.severity, workingHours, now);

    for (const channel of channels) {
      const address =
        channel === 'ui'
          ? uiChannel(alert.orgId)
          : channelAddrRows.find((a) => a.userId === userId && a.channel === channel)?.address;

      if (!address) {
        log.debug({ userId, channel }, 'no address, skipping');
        continue;
      }

      // Throttle: skip if rate limit exceeded (alert goes to digest queue)
      if (channel !== 'ui') {
        const allowed = await checkThrottle(redis, userId, channel, alert.id);
        if (!allowed) {
          log.debug({ userId, channel, alertId: alert.id }, 'throttled, added to digest');
          continue;
        }
      }

      deliveryValues.push({
        id: newId(),
        alertId: alert.id,
        userId,
        channel: channel as typeof t.deliveries.$inferInsert['channel'],
        address,
        payload: {},
        status: 'pending' as const,
        attempts: 0,
        nextAttemptAt: now.toISOString(),
      });
    }
  }

  if (deliveryValues.length > 0) {
    await db.insert(t.deliveries).values(deliveryValues).onConflictDoNothing();
  }

  // --- 6. Mark dispatched + set escalation ---
  const nextEscalationAt = new Date(now.getTime() + escalationAfterMin * 60_000).toISOString();
  await db
    .update(t.alerts)
    .set({ dispatchedAt: now.toISOString(), nextEscalationAt })
    .where(and(eq(t.alerts.id, alertId), isNull(t.alerts.dispatchedAt)));

  log.info({ alertId, recipients: userIds.length, deliveries: deliveryValues.length }, 'alert dispatched');
}
