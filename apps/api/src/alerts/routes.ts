/**
 * F-06 — alerts: list, detail, ACK / resolve / comment, runbook steps and approvals.
 * Runbook logic stays in @alerting/runbooks (B2-12); this layer only authorizes and maps errors.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { dedupKey, newId } from '@alerting/config';
import { AlertStatus, Severity, type TimelineEntry } from '@alerting/contracts';
import { alertFromRow, and, asc, desc, eq, gte, ilike, inArray, lt, lte, or, t, type Db } from '@alerting/db';
import { completeManualStep, decideApproval, runStepNow } from '@alerting/runbooks';
import type { Deps } from '../deps.ts';
import type { HttpError } from '../lib/errors.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { sha256 } from '../lib/crypto.ts';
import { page, PageQuery } from '../lib/pagination.ts';
import { publishUi } from '../lib/ui-events.ts';
import { requireAuth } from '../auth/guards.ts';
import { loadVisibleAlert, visibleAlerts } from './access.ts';

const AlertParams = z.object({ alertId: z.string().min(1).max(64) });
const StepParams = AlertParams.extend({ stepId: z.string().min(1).max(64) });
const Decision = z.object({ decision: z.enum(['approved', 'rejected']) });

/** `%` and `_` from user text must not act as wildcards. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** B2-12 error codes → HTTP. */
function fromStepError(code: string): HttpError {
  const notFoundCodes = ['approval_not_found', 'no_runbook_instance', 'step_not_found'];
  if (notFoundCodes.includes(code)) return notFound(code.replace(/_/g, ' '));
  return conflict(code, code.replace(/_/g, ' '));
}

async function timelineOf(db: Db, alertId: string) {
  return db
    .select({
      id: t.alertTimeline.id,
      alertId: t.alertTimeline.alertId,
      ts: t.alertTimeline.ts,
      actorType: t.alertTimeline.actorType,
      actorId: t.alertTimeline.actorId,
      actorName: t.users.name,
      kind: t.alertTimeline.kind,
      data: t.alertTimeline.data,
    })
    .from(t.alertTimeline)
    .leftJoin(t.users, eq(t.users.id, t.alertTimeline.actorId))
    .where(eq(t.alertTimeline.alertId, alertId))
    .orderBy(asc(t.alertTimeline.ts));
}

export async function alertRoutes(app: FastifyInstance, { db, redis }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Writes a timeline entry and pushes it (plus an optional alert patch) to the UI. */
  async function record(
    orgId: string,
    alertId: string,
    entry: Pick<TimelineEntry, 'actorType' | 'kind' | 'data'> & { actorId?: string },
    patch?: Record<string, unknown>,
  ) {
    const row = { id: newId(), alertId, ts: new Date().toISOString(), ...entry };
    await db.insert(t.alertTimeline).values(row);
    const { actorId, ...rest } = row;
    await publishUi(redis, orgId, {
      type: 'timeline.appended',
      alertId,
      entry: { ...rest, ...(actorId && { actorId }) },
    });
    if (patch) await publishUi(redis, orgId, { type: 'alert.updated', alertId, patch });
    return row;
  }

  r.get(
    '/alerts',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['alerts'],
        querystring: PageQuery.extend({
          teamId: z.string().optional(),
          status: z
            .string()
            .transform((s) => s.split(','))
            .pipe(z.array(AlertStatus))
            .optional(),
          severity: z
            .string()
            .transform((s) => s.split(','))
            .pipe(z.array(Severity))
            .optional(),
          ruleId: z.string().optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          q: z.string().trim().min(1).max(200).optional(),
          /** After a WebSocket reconnect: alerts that appeared or changed since this time. */
          changedSince: z.iso.datetime({ offset: true }).optional(),
        }),
      },
    },
    async (req) => {
      const { limit, cursor, teamId, status, severity, ruleId, from, to, q, changedSince } = req.query;
      const rows = await db
        .select()
        .from(t.alerts)
        .where(
          and(
            visibleAlerts(db, req.user),
            teamId ? eq(t.alerts.teamId, teamId) : undefined,
            status ? inArray(t.alerts.status, status) : undefined,
            severity ? inArray(t.alerts.severity, severity) : undefined,
            ruleId ? eq(t.alerts.ruleId, ruleId) : undefined,
            from ? gte(t.alerts.lastSeen, from) : undefined,
            to ? lte(t.alerts.lastSeen, to) : undefined,
            q ? ilike(t.alerts.title, `%${likeEscape(q)}%`) : undefined,
            changedSince
              ? or(
                  gte(t.alerts.lastSeen, changedSince),
                  gte(t.alerts.ackAt, changedSince),
                  gte(t.alerts.resolvedAt, changedSince),
                )
              : undefined,
            cursor ? lt(t.alerts.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(t.alerts.id))
        .limit(limit + 1);
      return page(rows.map(alertFromRow), limit);
    },
  );

  r.get(
    '/alerts/:alertId',
    {
      preHandler: requireAuth,
      schema: { tags: ['alerts'], summary: 'Alert with timeline, runbook, deliveries', params: AlertParams },
    },
    async (req) => {
      const row = await loadVisibleAlert(db, req.user, req.params.alertId);
      const [timeline, [instance], deliveries, approvals, [rule]] = await Promise.all([
        timelineOf(db, row.id),
        db.select().from(t.runbookInstances).where(eq(t.runbookInstances.alertId, row.id)).limit(1),
        // address (email / chat id) of other people is not shown
        db
          .select({
            id: t.deliveries.id,
            userId: t.deliveries.userId,
            userName: t.users.name,
            channel: t.deliveries.channel,
            status: t.deliveries.status,
            attempts: t.deliveries.attempts,
            lastError: t.deliveries.lastError,
            sentAt: t.deliveries.sentAt,
            fallbackOf: t.deliveries.fallbackOf,
          })
          .from(t.deliveries)
          .leftJoin(t.users, eq(t.users.id, t.deliveries.userId))
          .where(eq(t.deliveries.alertId, row.id))
          .orderBy(asc(t.deliveries.createdAt)),
        db
          .select({
            id: t.approvals.id,
            stepId: t.approvals.stepId,
            code: t.approvals.code,
            status: t.approvals.status,
            requestedAt: t.approvals.requestedAt,
            decidedBy: t.approvals.decidedBy,
            decidedAt: t.approvals.decidedAt,
            via: t.approvals.via,
          })
          .from(t.approvals)
          .where(eq(t.approvals.alertId, row.id))
          .orderBy(asc(t.approvals.requestedAt)),
        db
          .select({ id: t.rules.id, name: t.rules.name })
          .from(t.rules)
          .where(and(eq(t.rules.id, row.ruleId), eq(t.rules.orgId, req.user.orgId))),
      ]);
      return {
        alert: alertFromRow(row),
        rule: rule ?? null,
        timeline,
        runbook: instance ?? null,
        deliveries,
        approvals,
      };
    },
  );

  /** open → acknowledged. Stops escalation. */
  r.post(
    '/alerts/:alertId/ack',
    { preHandler: requireAuth, schema: { tags: ['alerts'], params: AlertParams } },
    async (req) => {
      const { orgId, sub } = req.user;
      const row = await loadVisibleAlert(db, req.user, req.params.alertId);
      const ackAt = new Date().toISOString();
      const [done] = await db
        .update(t.alerts)
        .set({ status: 'acknowledged', ackBy: sub, ackAt, nextEscalationAt: null })
        .where(and(eq(t.alerts.id, row.id), eq(t.alerts.orgId, orgId), eq(t.alerts.status, 'open')))
        .returning({ id: t.alerts.id });
      if (!done) throw conflict('invalid_state', `Alert is ${row.status}`);
      const patch = { status: 'acknowledged' as const, ackBy: sub, ackAt };
      await record(
        orgId,
        row.id,
        { actorType: 'user', actorId: sub, kind: 'ack', data: { via: 'ui' } },
        patch,
      );
      return { ...alertFromRow({ ...row, ...patch }) };
    },
  );

  /** open / acknowledged → resolved. The next matching event opens a new alert. */
  r.post(
    '/alerts/:alertId/resolve',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['alerts'],
        params: AlertParams,
        body: z.object({ note: z.string().trim().max(2000).optional() }).nullish(),
      },
    },
    async (req) => {
      const { orgId, sub } = req.user;
      const row = await loadVisibleAlert(db, req.user, req.params.alertId);
      const resolvedAt = new Date().toISOString();
      const [done] = await db
        .update(t.alerts)
        .set({ status: 'resolved', resolvedBy: sub, resolvedAt, nextEscalationAt: null })
        .where(
          and(
            eq(t.alerts.id, row.id),
            eq(t.alerts.orgId, orgId),
            inArray(t.alerts.status, ['open', 'acknowledged']),
          ),
        )
        .returning({ id: t.alerts.id });
      if (!done) throw conflict('invalid_state', 'Alert is already resolved');
      await redis.del(dedupKey(row.ruleId, row.groupKey));
      const patch = { status: 'resolved' as const, resolvedBy: sub, resolvedAt };
      await record(
        orgId,
        row.id,
        {
          actorType: 'user',
          actorId: sub,
          kind: 'resolve',
          data: { via: 'ui', ...(req.body?.note && { note: req.body.note }) },
        },
        patch,
      );
      return alertFromRow({ ...row, ...patch });
    },
  );

  r.post(
    '/alerts/:alertId/comment',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['alerts'],
        params: AlertParams,
        body: z.object({ text: z.string().trim().min(1).max(2000) }),
      },
    },
    async (req, reply) => {
      const row = await loadVisibleAlert(db, req.user, req.params.alertId);
      const entry = await record(req.user.orgId, row.id, {
        actorType: 'user',
        actorId: req.user.sub,
        kind: 'comment',
        data: { text: req.body.text },
      });
      return reply.code(201).send(entry);
    },
  );

  r.post(
    '/alerts/:alertId/steps/:stepId/complete',
    {
      preHandler: requireAuth,
      schema: { tags: ['alerts'], summary: 'Tick a manual runbook step', params: StepParams },
    },
    async (req) => {
      const row = await loadVisibleAlert(db, req.user, req.params.alertId);
      const res = await completeManualStep(db, redis, {
        alertId: row.id,
        stepId: req.params.stepId,
        actor: { type: 'user', id: req.user.sub },
      });
      if (!res.ok) throw fromStepError(res.error);
      return { ok: true };
    },
  );

  r.post(
    '/alerts/:alertId/steps/:stepId/run',
    {
      preHandler: requireAuth,
      schema: { tags: ['alerts'], summary: 'Run a runbook step now', params: StepParams },
    },
    async (req) => {
      const row = await loadVisibleAlert(db, req.user, req.params.alertId);
      // a step that needs approval runs only through the approval flow
      const [instance] = await db
        .select({ steps: t.runbookInstances.steps })
        .from(t.runbookInstances)
        .where(eq(t.runbookInstances.alertId, row.id));
      const step = instance?.steps.find((s) => s.id === req.params.stepId);
      if (step && (step.approval === 'required' || step.state === 'waiting_approval')) {
        throw conflict('approval_required', 'This step needs an approval; decide the approval instead');
      }
      const res = await runStepNow(db, redis, {
        alertId: row.id,
        stepId: req.params.stepId,
        actor: { type: 'user', id: req.user.sub },
      });
      if (!res.ok) throw fromStepError(res.error);
      return { ok: true };
    },
  );

  r.post(
    '/alerts/:alertId/approvals/:approvalId/decide',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['alerts'],
        params: AlertParams.extend({ approvalId: z.string().min(1).max(64) }),
        body: Decision,
      },
    },
    async (req) => {
      const row = await loadVisibleAlert(db, req.user, req.params.alertId);
      // the approval must belong to this (visible) alert — decideApproval looks it up by id only
      const [approval] = await db
        .select({ id: t.approvals.id })
        .from(t.approvals)
        .where(and(eq(t.approvals.id, req.params.approvalId), eq(t.approvals.alertId, row.id)));
      if (!approval) throw notFound('Approval not found');
      const res = await decideApproval(db, redis, {
        approvalId: approval.id,
        decision: req.body.decision,
        actor: { type: 'user', id: req.user.sub },
        via: 'ui',
      });
      if (!res.ok) throw fromStepError(res.error);
      req.log.info({
        event: 'approval_decided',
        approvalId: approval.id,
        by: req.user.sub,
        decision: req.body.decision,
      });
      return { ok: true, ...res.value };
    },
  );

  /**
   * Email "Approve" links: GET only shows what is being approved (link scanners must not decide);
   * the confirmation page then POSTs the decision. The long random token is the credential.
   */
  async function approvalByToken(token: string) {
    const [a] = await db
      .select({
        id: t.approvals.id,
        alertId: t.approvals.alertId,
        stepId: t.approvals.stepId,
        status: t.approvals.status,
        alertTitle: t.alerts.title,
        severity: t.alerts.severity,
      })
      .from(t.approvals)
      .innerJoin(t.alerts, eq(t.alerts.id, t.approvals.alertId))
      .where(eq(t.approvals.tokenHash, sha256(token)));
    if (!a) throw notFound('Approval link not found');
    return a;
  }
  const TokenParams = z.object({ token: z.string().min(32).max(100) });
  const tokenLimit = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  r.get(
    '/approve/:token',
    {
      config: tokenLimit,
      schema: { tags: ['alerts'], summary: 'What an email approval link approves', params: TokenParams },
    },
    async (req) => {
      const a = await approvalByToken(req.params.token);
      return { alertTitle: a.alertTitle, severity: a.severity, stepId: a.stepId, status: a.status };
    },
  );

  r.post(
    '/approve/:token',
    { config: tokenLimit, schema: { tags: ['alerts'], params: TokenParams, body: Decision } },
    async (req) => {
      const a = await approvalByToken(req.params.token);
      const res = await decideApproval(db, redis, {
        approvalId: a.id,
        decision: req.body.decision,
        actor: { type: 'system', id: 'email-link' },
        via: 'email',
      });
      if (!res.ok) throw fromStepError(res.error);
      req.log.info({
        event: 'approval_decided',
        approvalId: a.id,
        via: 'email',
        decision: req.body.decision,
      });
      return { ok: true, decision: req.body.decision };
    },
  );
}
