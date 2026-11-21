/**
 * B2-12: Shared functions for the runbook step engine — called by both
 * the notifier step engine and by apps/api (F), so logic is not duplicated.
 * Authorization is handled by the caller (API guards or Telegram auth check).
 * These functions accept already-verified data and return Result, never throw.
 */
import type { Db } from '@alerting/db';
import { t, eq, sql } from '@alerting/db';
import { newId, uiChannel, type Redis } from '@alerting/config';
import type { RunbookInstanceStep } from '@alerting/contracts';
import { ok, err, UiEvent } from '@alerting/contracts';
import type { Result } from '@alerting/contracts';

export interface Actor {
  type: 'user' | 'system';
  id: string;
}

function publishUiEvent(redis: Redis, orgId: string, event: unknown): void {
  try {
    const validated = UiEvent.parse(event);
    redis.publish(uiChannel(orgId), JSON.stringify(validated)).catch(() => {});
  } catch {
    // malformed event — do not publish
  }
}

export interface DecideApprovalInput {
  approvalId: string;
  decision: 'approved' | 'rejected';
  actor: Actor;
  via: 'ui' | 'telegram' | 'email';
}

export async function decideApproval(
  db: Db,
  redis: Redis,
  input: DecideApprovalInput,
): Promise<Result<{ alertId: string; stepId: string }>> {
  const now = new Date().toISOString();

  // Atomic UPDATE … WHERE status='pending' — guards against concurrent decisions
  const updated = await db
    .update(t.approvals)
    .set({ status: input.decision, decidedBy: input.actor.id, decidedAt: now, via: input.via })
    .where(sql`${t.approvals.id} = ${input.approvalId} AND ${t.approvals.status} = 'pending'`)
    .returning({ id: t.approvals.id, alertId: t.approvals.alertId, stepId: t.approvals.stepId });

  if (updated.length === 0) {
    // Either not found or already decided
    const existing = await db.query.approvals.findFirst({ where: eq(t.approvals.id, input.approvalId) });
    return existing ? err('already_decided') : err('approval_not_found');
  }

  const { alertId, stepId } = updated[0]!;

  const instance = await db.query.runbookInstances.findFirst({
    where: eq(t.runbookInstances.alertId, alertId),
  });

  if (instance) {
    const steps = instance.steps as RunbookInstanceStep[];
    const updatedSteps = steps.map((s) => {
      if (s.id !== stepId) return s;
      return {
        ...s,
        state: input.decision === 'approved' ? ('running' as const) : ('skipped' as const),
        completedBy: input.actor.id,
        completedAt: now,
      };
    });
    await db
      .update(t.runbookInstances)
      .set({ steps: updatedSteps })
      .where(eq(t.runbookInstances.id, instance.id));
  }

  const timelineId = newId();
  await db.insert(t.alertTimeline).values({
    id: timelineId,
    alertId,
    ts: now,
    actorType: input.actor.type,
    actorId: input.actor.id,
    kind: 'approval',
    data: { approvalId: input.approvalId, decision: input.decision, via: input.via },
  });

  const alertRow = await db.query.alerts.findFirst({ where: eq(t.alerts.id, alertId) });
  if (alertRow) {
    publishUiEvent(redis, alertRow.orgId, {
      type: 'timeline.appended',
      alertId,
      entry: {
        id: timelineId,
        alertId,
        ts: now,
        actorType: input.actor.type,
        actorId: input.actor.id,
        kind: 'approval',
        data: { approvalId: input.approvalId, decision: input.decision, via: input.via },
      },
    });
  }

  return ok({ alertId, stepId });
}

export interface CompleteManualStepInput {
  alertId: string;
  stepId: string;
  actor: Actor;
}

export async function completeManualStep(
  db: Db,
  redis: Redis,
  input: CompleteManualStepInput,
): Promise<Result<void>> {
  const instance = await db.query.runbookInstances.findFirst({
    where: eq(t.runbookInstances.alertId, input.alertId),
  });
  if (!instance) return err('no_runbook_instance');

  const steps = instance.steps as RunbookInstanceStep[];
  const step = steps.find((s) => s.id === input.stepId);
  if (!step) return err('step_not_found');
  if (step.kind !== 'manual') return err('not_manual_step');
  if (step.state === 'done') return err('already_done');

  const now = new Date().toISOString();
  const updatedSteps = steps.map((s) => {
    if (s.id !== input.stepId) return s;
    return { ...s, state: 'done' as const, completedBy: input.actor.id, completedAt: now };
  });

  await db
    .update(t.runbookInstances)
    .set({ steps: updatedSteps })
    .where(eq(t.runbookInstances.id, instance.id));

  const timelineId = newId();
  const alertRow = await db.query.alerts.findFirst({ where: eq(t.alerts.id, input.alertId) });

  await db.insert(t.alertTimeline).values({
    id: timelineId,
    alertId: input.alertId,
    ts: now,
    actorType: input.actor.type,
    actorId: input.actor.id,
    kind: 'step',
    data: { stepId: input.stepId, action: 'complete' },
  });

  if (alertRow) {
    publishUiEvent(redis, alertRow.orgId, {
      type: 'timeline.appended',
      alertId: input.alertId,
      entry: {
        id: timelineId,
        alertId: input.alertId,
        ts: now,
        actorType: input.actor.type,
        actorId: input.actor.id,
        kind: 'step',
        data: { stepId: input.stepId, action: 'complete' },
      },
    });
  }

  return ok(undefined);
}

export interface RunStepNowInput {
  alertId: string;
  stepId: string;
  actor: Actor;
}

export async function runStepNow(
  db: Db,
  redis: Redis,
  input: RunStepNowInput,
): Promise<Result<void>> {
  const instance = await db.query.runbookInstances.findFirst({
    where: eq(t.runbookInstances.alertId, input.alertId),
  });
  if (!instance) return err('no_runbook_instance');

  const steps = instance.steps as RunbookInstanceStep[];
  const step = steps.find((s) => s.id === input.stepId);
  if (!step) return err('step_not_found');

  const now = new Date().toISOString();
  const updatedSteps = steps.map((s) => {
    if (s.id !== input.stepId) return s;
    return { ...s, state: 'running' as const };
  });

  await db
    .update(t.runbookInstances)
    .set({ steps: updatedSteps })
    .where(eq(t.runbookInstances.id, instance.id));

  const timelineId = newId();
  const alertRow = await db.query.alerts.findFirst({ where: eq(t.alerts.id, input.alertId) });

  await db.insert(t.alertTimeline).values({
    id: timelineId,
    alertId: input.alertId,
    ts: now,
    actorType: input.actor.type,
    actorId: input.actor.id,
    kind: 'step',
    data: { stepId: input.stepId, action: 'run_now' },
  });

  if (alertRow) {
    publishUiEvent(redis, alertRow.orgId, {
      type: 'timeline.appended',
      alertId: input.alertId,
      entry: {
        id: timelineId,
        alertId: input.alertId,
        ts: now,
        actorType: input.actor.type,
        actorId: input.actor.id,
        kind: 'step',
        data: { stepId: input.stepId, action: 'run_now' },
      },
    });
  }

  return ok(undefined);
}
