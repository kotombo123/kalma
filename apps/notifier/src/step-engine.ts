/**
 * B2-09: Runbook step engine.
 * Advances pending runbook steps for open alerts on each tick:
 * - 'check'/'action' with risk='low' and approval='none' → auto-execute
 * - approval='required' or risk='high' → create approvals row, notify
 * - 'manual' steps wait for completeManualStep() call from API/Telegram
 * - Handles 'if' conditions: previous_failed, retry_failed:N
 * - B2-10: on last successful action/check with onRunbookSuccess=true → auto-resolve
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from '@alerting/config';
import { env, newId } from '@alerting/config';
import { type Db, t, eq, and, inArray, desc, alertFromRow } from '@alerting/db';
import type { RunbookInstanceStep } from '@alerting/contracts';
import { getAction } from '@alerting/actions';
import type { Alert as AlertType } from '@alerting/contracts';

const POLL_INTERVAL_MS = 5_000;

export async function runStepEngine(db: Db, log: Logger): Promise<void> {
  log.info('step engine started');
  while (true) {
    await tickStepEngine(db, log);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function tickStepEngine(db: Db, log: Logger): Promise<void> {
  // Only alerts that have a runbook, newest first (ULID = creation time): with thousands of open
  // alerts an arbitrary LIMIT starved new ones. Acknowledging an alert must not stop its runbook.
  const openAlerts = await db
    .select({ id: t.alerts.id, orgId: t.alerts.orgId, ruleId: t.alerts.ruleId })
    .from(t.alerts)
    .innerJoin(t.runbookInstances, eq(t.runbookInstances.alertId, t.alerts.id))
    .where(inArray(t.alerts.status, ['open', 'acknowledged']))
    .orderBy(desc(t.alerts.id))
    .limit(50);

  for (const alertSummary of openAlerts) {
    const instance = await db.query.runbookInstances.findFirst({
      where: eq(t.runbookInstances.alertId, alertSummary.id),
    });
    if (!instance) continue;

    const steps = instance.steps as RunbookInstanceStep[];
    const alertRow = await db.query.alerts.findFirst({ where: eq(t.alerts.id, alertSummary.id) });
    if (!alertRow || alertRow.status === 'resolved') continue;
    const alert = alertFromRow(alertRow);

    let changed = false;
    const updated = [...steps];

    /** Runs step i (check / action), records the result, auto-resolves after the last step. */
    const runAutomatic = async (i: number) => {
      const step = updated[i]!;
      updated[i] = { ...step, state: 'running', attempts: (step.attempts ?? 0) + 1 };
      const result = await executeStep(step, alert, log);
      updated[i] = {
        ...updated[i]!,
        state: result.ok ? 'done' : 'failed',
        result,
        completedAt: new Date().toISOString(),
      };
      await db.insert(t.alertTimeline).values({
        id: newId(),
        alertId: alertSummary.id,
        ts: new Date().toISOString(),
        actorType: 'system',
        kind: 'action',
        data: { stepId: step.id, kind: step.kind, ok: result.ok, error: result.error },
      });
      // B2-10: auto-resolve if the last step succeeded and the rule has onRunbookSuccess
      if (result.ok && i === updated.length - 1) {
        const ruleRow = await db.query.rules.findFirst({ where: eq(t.rules.id, alertSummary.ruleId) });
        if (ruleRow?.definition?.autoResolve?.onRunbookSuccess) {
          await db
            .update(t.alerts)
            .set({
              status: 'resolved',
              resolvedBy: 'system',
              resolvedAt: new Date().toISOString(),
              nextEscalationAt: null,
            })
            .where(eq(t.alerts.id, alertSummary.id));
          await db.insert(t.alertTimeline).values({
            id: newId(),
            alertId: alertSummary.id,
            ts: new Date().toISOString(),
            actorType: 'system',
            kind: 'resolve',
            data: { reason: 'runbook_success' },
          });
          log.info({ alertId: alertSummary.id }, 'auto-resolved after runbook success');
        }
      }
    };

    for (let i = 0; i < updated.length; i++) {
      const step = updated[i]!;

      // A step that needed approval: decideApproval marks it 'running' (approved) or 'skipped'
      // (rejected). Run it here once the approval is granted; keep waiting while it is pending.
      const gated =
        step.approval === 'required' ||
        (step.kind === 'action' && step.action !== undefined && getActionRisk(step.action.type) === 'high');
      if (gated && (step.state === 'running' || step.state === 'waiting_approval')) {
        const approval = await db.query.approvals.findFirst({
          where: and(eq(t.approvals.alertId, alertSummary.id), eq(t.approvals.stepId, step.id)),
        });
        if (!approval || approval.status === 'pending') break;
        if (approval.status !== 'approved') {
          updated[i] = { ...step, state: 'skipped' };
          changed = true;
          continue;
        }
        await runAutomatic(i);
        changed = true;
        if (updated[i]!.state === 'failed') break;
        continue;
      }
      if (step.state !== 'pending') continue;

      // --- Evaluate 'if' condition ---
      if (step.if) {
        const shouldSkip = evaluateIf(step.if, updated, i);
        if (shouldSkip) {
          updated[i] = { ...step, state: 'skipped' };
          changed = true;
          continue;
        }
      }

      if (step.kind === 'manual' || step.kind === 'read' || step.kind === 'link') {
        // These require human action — leave as pending
        break;
      }

      const needsApproval =
        step.approval === 'required' ||
        (step.kind === 'action' && step.action && getActionRisk(step.action.type) === 'high');

      if (needsApproval) {
        // Create approval row (idempotent)
        const existing = await db.query.approvals.findFirst({
          where: and(eq(t.approvals.alertId, alertSummary.id), eq(t.approvals.stepId, step.id)),
        });
        if (!existing) {
          const code = generateCode();
          // Email link token: 32 random bytes, stored as sha256 hex
          const rawToken = randomBytes(32).toString('base64url');
          const tokenHash = createHash('sha256').update(rawToken).digest('hex');
          const approvalId = newId();
          await db.insert(t.approvals).values({
            id: approvalId,
            alertId: alertSummary.id,
            stepId: step.id,
            code, // 4-char code for Telegram ("YES 7F3K")
            tokenHash, // sha256 of rawToken — email link uses rawToken
            status: 'pending',
          });

          // Find email addresses for all alert team members so dispatcher
          // can send approval-request emails with the one-time rawToken link
          const members = await db.query.teamMembers.findMany({
            where: eq(t.teamMembers.teamId, alertRow.teamId),
          });
          for (const member of members) {
            const emailAddr = await db.query.channelAddresses.findFirst({
              where: and(
                eq(t.channelAddresses.userId, member.userId),
                eq(t.channelAddresses.channel, 'email'),
              ),
            });
            if (!emailAddr) continue;
            await db
              .insert(t.deliveries)
              .values({
                id: newId(),
                alertId: alertSummary.id,
                userId: member.userId,
                channel: 'email',
                address: emailAddr.address,
                payload: { approvalRequest: true, approvalId, approvalToken: rawToken, approvalCode: code },
                status: 'pending',
                attempts: 0,
                nextAttemptAt: new Date().toISOString(),
              })
              .onConflictDoNothing();
          }

          updated[i] = { ...step, state: 'waiting_approval' };
          changed = true;
        }
        break;
      }

      // --- Auto-execute low-risk steps ---
      if (step.kind === 'check' || (step.kind === 'action' && step.action)) {
        await runAutomatic(i);
        changed = true;
      }
    }

    if (changed) {
      await db
        .update(t.runbookInstances)
        .set({ steps: updated })
        .where(eq(t.runbookInstances.id, instance.id));
    }
  }
}

function evaluateIf(condition: string, steps: RunbookInstanceStep[], currentIdx: number): boolean {
  if (condition === 'previous_failed') {
    const prev = steps[currentIdx - 1];
    return prev?.state !== 'failed';
  }
  if (condition.startsWith('retry_failed:')) {
    const maxRetries = parseInt(condition.split(':')[1] ?? '0', 10);
    const prev = steps[currentIdx - 1];
    if (prev?.state !== 'failed') return true;
    return (prev.attempts ?? 0) < maxRetries;
  }
  return false;
}

function getActionRisk(actionType: string): 'low' | 'high' {
  const action = getAction(actionType);
  return action?.risk ?? 'low';
}

/** Services demo-systems simulates (runbooks address them by host name, e.g. http://counterparty-service/health). */
const DEMO_SERVICES = new Set(['payments-api', 'counterparty-service', 'workflow-engine', 'pricing-engine']);

/**
 * fetch for actions in the demo environment: `http://demo-systems:3002/…` and
 * `http://<simulated-service>/…` go to DEMO_SYSTEMS_URL, so runbooks work in Docker and with
 * `pnpm dev`. Any other URL is fetched as is.
 */
export function demoAwareFetch(demoUrl = env().DEMO_SYSTEMS_URL): typeof fetch {
  const base = demoUrl.replace(/\/$/, '');
  return (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url = raw;
    try {
      const u = new URL(raw);
      if (u.hostname === 'demo-systems') url = `${base}${u.pathname}${u.search}`;
      else if (DEMO_SERVICES.has(u.hostname) && !u.port)
        url = `${base}/services/${u.hostname}${u.pathname}${u.search}`;
    } catch {
      /* not an absolute URL — let fetch report it */
    }
    return globalThis.fetch(url, init);
  };
}

async function executeStep(
  step: RunbookInstanceStep,
  alertRow: AlertType,
  log: Logger,
): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  // the filler stores values resolved from the alert ({{workflowId}} → WF-…) in actionFilled
  const action =
    (step as RunbookInstanceStep & { actionFilled?: RunbookInstanceStep['action'] }).actionFilled ??
    step.action;
  // a check without an action is a note for the human; with one (http_get…) it really runs
  if (!action) return { ok: true };

  const actionDef = getAction(action.type);
  if (!actionDef) return { ok: false, error: `unknown action type: ${action.type}` };

  // Context every action may use (runbooks rarely spell it out): the alert id and a message.
  // YAML runbooks keep `url:` on the step. Explicit params win; each schema drops unknown keys.
  const raw = {
    alertId: alertRow.id,
    message: alertRow.title,
    ...(step.url && action.params.url === undefined && { url: step.url }),
    ...action.params,
  };
  // validate + apply defaults (e.g. timeoutMs) — without this a missing timeout aborted the request at once
  const parsed = actionDef.params.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, error: `invalid parameters for ${action.type}: ${why}` };
  }
  try {
    return await actionDef.execute(parsed.data, { alert: alertRow, logger: log, fetch: demoAwareFetch() });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
