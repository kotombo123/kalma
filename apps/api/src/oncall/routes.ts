/** F-07 (part 2) — on-call schedules, overrides and "who is on call now" (@alerting/oncall). */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { newId } from '@alerting/config';
import { and, asc, eq, gte, inArray, t, type Db } from '@alerting/db';
import { whoIsOnCall } from '@alerting/oncall';
import type { Deps } from '../deps.ts';
import { HttpError, notFound } from '../lib/errors.ts';
import { publishConfigChanged } from '../lib/config-changed.ts';
import { deny, requireAuth, teamRoleOf } from '../auth/guards.ts';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const ScheduleBody = z.object({
  teamId: z.string().min(1),
  rotation: z.enum(['daily', 'weekly']),
  handoffTime: HHMM,
  timezone: z.string().min(1).max(64),
  participants: z.array(z.string().min(1)).min(1).max(50),
  startDate: z.iso.date(),
});
const IdParams = z.object({ scheduleId: z.string().min(1).max(64) });

async function loadSchedule(db: Db, orgId: string, id: string) {
  const [s] = await db
    .select({
      id: t.oncallSchedules.id,
      teamId: t.oncallSchedules.teamId,
      rotation: t.oncallSchedules.rotation,
      handoffTime: t.oncallSchedules.handoffTime,
      timezone: t.oncallSchedules.timezone,
      participants: t.oncallSchedules.participants,
      startDate: t.oncallSchedules.startDate,
    })
    .from(t.oncallSchedules)
    .innerJoin(t.teams, eq(t.teams.id, t.oncallSchedules.teamId))
    .where(and(eq(t.oncallSchedules.id, id), eq(t.teams.orgId, orgId)));
  if (!s) throw notFound('Schedule not found');
  return s;
}

async function requireLead(db: Db, req: FastifyRequest, teamId: string) {
  if (req.user.role === 'admin') return;
  if ((await teamRoleOf(db, req.user.orgId, teamId, req.user.sub)) !== 'lead')
    throw deny(req, 'Team lead required');
}

/** Participants must be members of the team (people outside it cannot be put on call). */
async function checkParticipants(db: Db, teamId: string, userIds: string[]) {
  const rows = await db
    .select({ userId: t.teamMembers.userId })
    .from(t.teamMembers)
    .where(and(eq(t.teamMembers.teamId, teamId), inArray(t.teamMembers.userId, userIds)));
  const inTeam = new Set(rows.map((r) => r.userId));
  const bad = userIds.filter((u) => !inTeam.has(u));
  if (bad.length) {
    throw new HttpError(400, 'not_in_team', 'Every participant must be a member of the team', [
      { path: ['body', 'participants'], message: `Not in the team: ${bad.join(', ')}` },
    ]);
  }
}

export async function oncallRoutes(app: FastifyInstance, { db, redis }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const changed = (orgId: string, id: string) => publishConfigChanged(redis, { kind: 'oncall', orgId, id });

  async function withNow(s: Awaited<ReturnType<typeof loadSchedule>>) {
    const overrides = await db
      .select({
        id: t.oncallOverrides.id,
        scheduleId: t.oncallOverrides.scheduleId,
        userId: t.oncallOverrides.userId,
        startsAt: t.oncallOverrides.startsAt,
        endsAt: t.oncallOverrides.endsAt,
      })
      .from(t.oncallOverrides)
      .where(
        and(eq(t.oncallOverrides.scheduleId, s.id), gte(t.oncallOverrides.endsAt, new Date().toISOString())),
      )
      .orderBy(asc(t.oncallOverrides.startsAt));
    const now = whoIsOnCall(s, overrides, new Date());
    return { ...s, overrides, onCallNow: now };
  }

  r.get(
    '/oncall/schedules',
    {
      preHandler: requireAuth,
      schema: { tags: ['oncall'], querystring: z.object({ teamId: z.string().optional() }) },
    },
    async (req) => {
      const rows = await db
        .select({ id: t.oncallSchedules.id })
        .from(t.oncallSchedules)
        .innerJoin(t.teams, eq(t.teams.id, t.oncallSchedules.teamId))
        .where(
          and(
            eq(t.teams.orgId, req.user.orgId),
            req.query.teamId ? eq(t.oncallSchedules.teamId, req.query.teamId) : undefined,
          ),
        );
      const data = await Promise.all(
        rows.map(async (x) => withNow(await loadSchedule(db, req.user.orgId, x.id))),
      );
      return { data };
    },
  );

  r.post(
    '/oncall/schedules',
    { preHandler: requireAuth, schema: { tags: ['oncall'], body: ScheduleBody } },
    async (req, reply) => {
      const { orgId } = req.user;
      const b = req.body;
      const [team] = await db
        .select({ id: t.teams.id })
        .from(t.teams)
        .where(and(eq(t.teams.id, b.teamId), eq(t.teams.orgId, orgId)));
      if (!team) throw notFound('Team not found');
      await requireLead(db, req, b.teamId);
      await checkParticipants(db, b.teamId, b.participants);
      const id = newId();
      await db.insert(t.oncallSchedules).values({ id, ...b });
      await changed(orgId, id);
      return reply
        .code(201)
        .header('location', `/oncall/schedules/${id}`)
        .send(await withNow(await loadSchedule(db, orgId, id)));
    },
  );

  r.put(
    '/oncall/schedules/:scheduleId',
    {
      preHandler: requireAuth,
      schema: { tags: ['oncall'], params: IdParams, body: ScheduleBody.omit({ teamId: true }) },
    },
    async (req) => {
      const { orgId } = req.user;
      const s = await loadSchedule(db, orgId, req.params.scheduleId);
      await requireLead(db, req, s.teamId);
      await checkParticipants(db, s.teamId, req.body.participants);
      await db.update(t.oncallSchedules).set(req.body).where(eq(t.oncallSchedules.id, s.id));
      await changed(orgId, s.id);
      return withNow(await loadSchedule(db, orgId, s.id));
    },
  );

  r.delete(
    '/oncall/schedules/:scheduleId',
    { preHandler: requireAuth, schema: { tags: ['oncall'], params: IdParams } },
    async (req, reply) => {
      const s = await loadSchedule(db, req.user.orgId, req.params.scheduleId);
      await requireLead(db, req, s.teamId);
      await db.delete(t.oncallSchedules).where(eq(t.oncallSchedules.id, s.id));
      await changed(req.user.orgId, s.id);
      return reply.code(204).send();
    },
  );

  /** Someone covers a time window (holiday swap). Leads add them; members can add one for themselves. */
  r.post(
    '/oncall/schedules/:scheduleId/overrides',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['oncall'],
        params: IdParams,
        body: z
          .object({
            userId: z.string().min(1),
            startsAt: z.iso.datetime({ offset: true }),
            endsAt: z.iso.datetime({ offset: true }),
          })
          .refine((o) => new Date(o.endsAt) > new Date(o.startsAt), {
            message: 'endsAt must be after startsAt',
            path: ['endsAt'],
          }),
      },
    },
    async (req, reply) => {
      const { orgId, sub } = req.user;
      const s = await loadSchedule(db, orgId, req.params.scheduleId);
      if (req.body.userId !== sub) await requireLead(db, req, s.teamId);
      await checkParticipants(db, s.teamId, [req.body.userId]);
      const id = newId();
      await db.insert(t.oncallOverrides).values({ id, scheduleId: s.id, ...req.body });
      await changed(orgId, s.id);
      return reply.code(201).send(await withNow(await loadSchedule(db, orgId, s.id)));
    },
  );

  r.delete(
    '/oncall/schedules/:scheduleId/overrides/:overrideId',
    {
      preHandler: requireAuth,
      schema: { tags: ['oncall'], params: IdParams.extend({ overrideId: z.string().min(1).max(64) }) },
    },
    async (req, reply) => {
      const { orgId, sub } = req.user;
      const s = await loadSchedule(db, orgId, req.params.scheduleId);
      const [o] = await db
        .select({ userId: t.oncallOverrides.userId })
        .from(t.oncallOverrides)
        .where(and(eq(t.oncallOverrides.id, req.params.overrideId), eq(t.oncallOverrides.scheduleId, s.id)));
      if (!o) throw notFound('Override not found');
      if (o.userId !== sub) await requireLead(db, req, s.teamId);
      await db.delete(t.oncallOverrides).where(eq(t.oncallOverrides.id, req.params.overrideId));
      await changed(orgId, s.id);
      return reply.code(204).send();
    },
  );

  /** Who is on call right now, per schedule of the org (or of one team). */
  r.get(
    '/oncall/now',
    {
      preHandler: requireAuth,
      schema: { tags: ['oncall'], querystring: z.object({ teamId: z.string().optional() }) },
    },
    async (req) => {
      const rows = await db
        .select({ id: t.oncallSchedules.id, teamName: t.teams.name })
        .from(t.oncallSchedules)
        .innerJoin(t.teams, eq(t.teams.id, t.oncallSchedules.teamId))
        .where(
          and(
            eq(t.teams.orgId, req.user.orgId),
            req.query.teamId ? eq(t.oncallSchedules.teamId, req.query.teamId) : undefined,
          ),
        );
      const out = [];
      for (const row of rows) {
        const s = await withNow(await loadSchedule(db, req.user.orgId, row.id));
        const [user] = await db
          .select({ name: t.users.name })
          .from(t.users)
          .where(eq(t.users.id, s.onCallNow.userId));
        out.push({
          scheduleId: s.id,
          teamId: s.teamId,
          teamName: row.teamName,
          userId: s.onCallNow.userId,
          userName: user?.name ?? null,
          viaOverride: Boolean(s.onCallNow.overrideId),
        });
      }
      return { data: out };
    },
  );
}
