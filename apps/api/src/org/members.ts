import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, gt, inArray, t, type Db } from '@alerting/db';
import type { Deps } from '../deps.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { page, PageQuery } from '../lib/pagination.ts';
import { publishConfigChanged } from '../lib/config-changed.ts';
import { requireAuth, requireOrgAdmin } from '../auth/guards.ts';

const UserParams = z.object({ userId: z.string().min(1).max(64) });

async function adminCount(db: Db, orgId: string) {
  const rows = await db
    .select({ userId: t.memberships.userId })
    .from(t.memberships)
    .where(and(eq(t.memberships.orgId, orgId), eq(t.memberships.role, 'admin')));
  return rows.length;
}

async function membership(db: Db, orgId: string, userId: string) {
  const [m] = await db
    .select({ role: t.memberships.role })
    .from(t.memberships)
    .where(and(eq(t.memberships.orgId, orgId), eq(t.memberships.userId, userId)));
  if (!m) throw notFound('Member not found');
  return m;
}

/** Org members (people of the org with their org role). */
export async function memberRoutes(app: FastifyInstance, { db, redis }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/members',
    { preHandler: requireAuth, schema: { tags: ['members'], querystring: PageQuery } },
    async (req) => {
      const { limit, cursor } = req.query;
      const rows = await db
        .select({ id: t.users.id, email: t.users.email, name: t.users.name, role: t.memberships.role })
        .from(t.memberships)
        .innerJoin(t.users, eq(t.users.id, t.memberships.userId))
        .where(and(eq(t.memberships.orgId, req.user.orgId), cursor ? gt(t.users.id, cursor) : undefined))
        .orderBy(asc(t.users.id))
        .limit(limit + 1);
      return page(rows, limit);
    },
  );

  r.patch(
    '/members/:userId',
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ['members'],
        params: UserParams,
        body: z.object({ role: z.enum(['admin', 'member']) }),
      },
    },
    async (req) => {
      const { orgId } = req.user;
      const { userId } = req.params;
      const current = await membership(db, orgId, userId);
      if (current.role === 'admin' && req.body.role === 'member' && (await adminCount(db, orgId)) <= 1) {
        throw conflict('last_admin', 'The organization needs at least one admin');
      }
      await db
        .update(t.memberships)
        .set({ role: req.body.role })
        .where(and(eq(t.memberships.orgId, orgId), eq(t.memberships.userId, userId)));
      req.log.info({ event: 'member_role_changed', by: req.user.sub, userId, role: req.body.role });
      return { id: userId, role: req.body.role };
    },
  );

  /** Removes the user from the org and from all its teams. */
  r.delete(
    '/members/:userId',
    { preHandler: requireOrgAdmin, schema: { tags: ['members'], params: UserParams } },
    async (req, reply) => {
      const { orgId } = req.user;
      const { userId } = req.params;
      const current = await membership(db, orgId, userId);
      if (current.role === 'admin' && (await adminCount(db, orgId)) <= 1) {
        throw conflict('last_admin', 'The organization needs at least one admin');
      }
      await db.transaction(async (tx) => {
        const orgTeams = tx.select({ id: t.teams.id }).from(t.teams).where(eq(t.teams.orgId, orgId));
        await tx
          .delete(t.teamMembers)
          .where(and(eq(t.teamMembers.userId, userId), inArray(t.teamMembers.teamId, orgTeams)));
        await tx
          .delete(t.memberships)
          .where(and(eq(t.memberships.orgId, orgId), eq(t.memberships.userId, userId)));
      });
      req.log.info({ event: 'member_removed', by: req.user.sub, userId });
      await publishConfigChanged(redis, { kind: 'teams', orgId });
      return reply.code(204).send();
    },
  );
}
