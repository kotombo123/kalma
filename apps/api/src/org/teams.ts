import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { newId } from '@alerting/config';
import { and, asc, count, eq, gt, t, type Db } from '@alerting/db';
import type { Deps } from '../deps.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { page, PageQuery } from '../lib/pagination.ts';
import { publishConfigChanged } from '../lib/config-changed.ts';
import { deny, requireAuth, requireOrgAdmin, requireTeamRole, teamRoleOf } from '../auth/guards.ts';

const TeamParams = z.object({ teamId: z.string().min(1).max(64) });
const MemberParams = TeamParams.extend({ userId: z.string().min(1).max(64) });
const Name = z.string().trim().min(1).max(100);
/** Teams "Workflows" webhooks are HTTPS; the notifier POSTs to this URL. */
const WebhookUrl = z.url({ protocol: /^https$/ }).max(2000);

async function loadTeam(db: Db, orgId: string, teamId: string) {
  const [team] = await db
    .select({ id: t.teams.id, name: t.teams.name, teamsWebhookUrl: t.teams.teamsWebhookUrl })
    .from(t.teams)
    .where(and(eq(t.teams.id, teamId), eq(t.teams.orgId, orgId)));
  if (!team) throw notFound('Team not found');
  return team;
}

async function teamMembers(db: Db, teamId: string) {
  return db
    .select({ id: t.users.id, name: t.users.name, email: t.users.email, role: t.teamMembers.role })
    .from(t.teamMembers)
    .innerJoin(t.users, eq(t.users.id, t.teamMembers.userId))
    .where(eq(t.teamMembers.teamId, teamId))
    .orderBy(asc(t.users.name));
}

/**
 * The Teams webhook URL is a bearer secret (anyone holding it can post to the channel):
 * only org admins and the team's leads see it; others only see whether one is set.
 */
async function visibleTeam(
  db: Db,
  user: { sub: string; orgId: string; role: string },
  team: Awaited<ReturnType<typeof loadTeam>>,
) {
  const canSee = user.role === 'admin' || (await teamRoleOf(db, user.orgId, team.id, user.sub)) === 'lead';
  return {
    ...team,
    teamsWebhookUrl: canSee ? team.teamsWebhookUrl : null,
    teamsWebhookConfigured: team.teamsWebhookUrl !== null,
  };
}

export async function teamRoutes(app: FastifyInstance, { db, redis }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const teamIdOf = (req: { params: unknown }) => (req.params as { teamId?: string }).teamId;
  const changed = (orgId: string, id: string) => publishConfigChanged(redis, { kind: 'teams', orgId, id });

  r.get(
    '/teams',
    { preHandler: requireAuth, schema: { tags: ['teams'], querystring: PageQuery } },
    async (req) => {
      const { limit, cursor } = req.query;
      const rows = await db
        .select({ id: t.teams.id, name: t.teams.name, memberCount: count(t.teamMembers.userId) })
        .from(t.teams)
        .leftJoin(t.teamMembers, eq(t.teamMembers.teamId, t.teams.id))
        .where(and(eq(t.teams.orgId, req.user.orgId), cursor ? gt(t.teams.id, cursor) : undefined))
        .groupBy(t.teams.id)
        .orderBy(asc(t.teams.id))
        .limit(limit + 1);
      return page(rows, limit);
    },
  );

  r.post(
    '/teams',
    {
      preHandler: requireOrgAdmin,
      schema: { tags: ['teams'], body: z.object({ name: Name, teamsWebhookUrl: WebhookUrl.optional() }) },
    },
    async (req, reply) => {
      const id = newId();
      const team = {
        id,
        orgId: req.user.orgId,
        name: req.body.name,
        teamsWebhookUrl: req.body.teamsWebhookUrl ?? null,
      };
      await db.insert(t.teams).values(team);
      await changed(req.user.orgId, id);
      return reply
        .code(201)
        .header('location', `/teams/${id}`)
        .send({
          id,
          name: team.name,
          teamsWebhookUrl: team.teamsWebhookUrl,
          teamsWebhookConfigured: team.teamsWebhookUrl !== null,
          members: [],
        });
    },
  );

  r.get(
    '/teams/:teamId',
    { preHandler: requireAuth, schema: { tags: ['teams'], params: TeamParams } },
    async (req) => ({
      ...(await visibleTeam(db, req.user, await loadTeam(db, req.user.orgId, req.params.teamId))),
      members: await teamMembers(db, req.params.teamId),
    }),
  );

  r.patch(
    '/teams/:teamId',
    {
      preHandler: requireTeamRole(db, teamIdOf, 'lead'),
      schema: {
        tags: ['teams'],
        params: TeamParams,
        body: z.object({ name: Name.optional(), teamsWebhookUrl: WebhookUrl.nullable().optional() }),
      },
    },
    async (req) => {
      const { orgId } = req.user;
      await loadTeam(db, orgId, req.params.teamId);
      const { name, teamsWebhookUrl } = req.body;
      if (name === undefined && teamsWebhookUrl === undefined)
        throw badRequest('empty_patch', 'Nothing to update');
      await db
        .update(t.teams)
        .set({
          ...(name !== undefined && { name }),
          ...(teamsWebhookUrl !== undefined && { teamsWebhookUrl }),
        })
        .where(and(eq(t.teams.id, req.params.teamId), eq(t.teams.orgId, orgId)));
      await changed(orgId, req.params.teamId);
      return {
        ...(await loadTeam(db, orgId, req.params.teamId)),
        members: await teamMembers(db, req.params.teamId),
      };
    },
  );

  /** Refuses when rules, runbooks or on-call schedules still belong to the team (they would be deleted too). */
  r.delete(
    '/teams/:teamId',
    { preHandler: requireOrgAdmin, schema: { tags: ['teams'], params: TeamParams } },
    async (req, reply) => {
      const { orgId } = req.user;
      const { teamId } = req.params;
      await loadTeam(db, orgId, teamId);
      const [[rules], [runbooks], [schedules]] = await Promise.all([
        db.select({ n: count() }).from(t.rules).where(eq(t.rules.teamId, teamId)),
        db.select({ n: count() }).from(t.runbooks).where(eq(t.runbooks.teamId, teamId)),
        db.select({ n: count() }).from(t.oncallSchedules).where(eq(t.oncallSchedules.teamId, teamId)),
      ]);
      if ((rules?.n ?? 0) + (runbooks?.n ?? 0) + (schedules?.n ?? 0) > 0) {
        throw conflict(
          'team_in_use',
          'Move or delete the team’s rules, runbooks and on-call schedules first',
        );
      }
      await db.delete(t.teams).where(and(eq(t.teams.id, teamId), eq(t.teams.orgId, orgId)));
      await changed(orgId, teamId);
      return reply.code(204).send();
    },
  );

  /**
   * Add a member or change their team role (idempotent). The user must already be in the org.
   * Team leads may add / keep people as `member` only and cannot change another lead.
   */
  r.put(
    '/teams/:teamId/members/:userId',
    {
      preHandler: requireTeamRole(db, teamIdOf, 'lead'),
      schema: { tags: ['teams'], params: MemberParams, body: z.object({ role: z.enum(['lead', 'member']) }) },
    },
    async (req) => {
      const { orgId, role: orgRole } = req.user;
      const { teamId, userId } = req.params;
      await loadTeam(db, orgId, teamId);
      const [inOrg] = await db
        .select({ userId: t.memberships.userId })
        .from(t.memberships)
        .where(and(eq(t.memberships.orgId, orgId), eq(t.memberships.userId, userId)));
      if (!inOrg) throw notFound('User is not a member of this organization');
      const [existing] = await db
        .select({ role: t.teamMembers.role })
        .from(t.teamMembers)
        .where(and(eq(t.teamMembers.teamId, teamId), eq(t.teamMembers.userId, userId)));
      if (orgRole !== 'admin' && (req.body.role === 'lead' || existing?.role === 'lead')) {
        throw deny(req, 'Only org admins can appoint or change team leads');
      }
      await db
        .insert(t.teamMembers)
        .values({ teamId, userId, role: req.body.role })
        .onConflictDoUpdate({
          target: [t.teamMembers.teamId, t.teamMembers.userId],
          set: { role: req.body.role },
        });
      await changed(orgId, teamId);
      return { teamId, userId, role: req.body.role };
    },
  );

  r.delete(
    '/teams/:teamId/members/:userId',
    { preHandler: requireTeamRole(db, teamIdOf, 'lead'), schema: { tags: ['teams'], params: MemberParams } },
    async (req, reply) => {
      const { orgId, role: orgRole } = req.user;
      const { teamId, userId } = req.params;
      await loadTeam(db, orgId, teamId);
      const [existing] = await db
        .select({ role: t.teamMembers.role })
        .from(t.teamMembers)
        .where(and(eq(t.teamMembers.teamId, teamId), eq(t.teamMembers.userId, userId)));
      if (!existing) throw notFound('User is not in this team');
      if (orgRole !== 'admin' && existing.role === 'lead')
        throw deny(req, 'Only org admins can remove team leads');
      await db
        .delete(t.teamMembers)
        .where(and(eq(t.teamMembers.teamId, teamId), eq(t.teamMembers.userId, userId)));
      await changed(orgId, teamId);
      return reply.code(204).send();
    },
  );
}
