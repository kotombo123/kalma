import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { newId } from '@alerting/config';
import { and, asc, count, eq, gt, t, type Db } from '@alerting/db';
import type { Deps } from '../deps.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { page, PageQuery } from '../lib/pagination.ts';
import { requireAuth, requireOrgAdmin } from '../auth/guards.ts';

const SystemParams = z.object({ systemId: z.string().min(1).max(64) });
const Name = z.string().trim().min(1).max(100);
const Description = z.string().trim().max(500);

export async function loadSystem(db: Db, orgId: string, systemId: string) {
  const [s] = await db
    .select({ id: t.systems.id, name: t.systems.name, description: t.systems.description })
    .from(t.systems)
    .where(and(eq(t.systems.id, systemId), eq(t.systems.orgId, orgId)));
  if (!s) throw notFound('System not found');
  return s;
}

/** A system groups the sources of one product / service. */
export async function systemRoutes(app: FastifyInstance, { db }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/systems',
    { preHandler: requireAuth, schema: { tags: ['systems'], querystring: PageQuery } },
    async (req) => {
      const { limit, cursor } = req.query;
      const rows = await db
        .select({
          id: t.systems.id,
          name: t.systems.name,
          description: t.systems.description,
          sourceCount: count(t.sources.id),
        })
        .from(t.systems)
        .leftJoin(t.sources, eq(t.sources.systemId, t.systems.id))
        .where(and(eq(t.systems.orgId, req.user.orgId), cursor ? gt(t.systems.id, cursor) : undefined))
        .groupBy(t.systems.id)
        .orderBy(asc(t.systems.id))
        .limit(limit + 1);
      return page(rows, limit);
    },
  );

  r.post(
    '/systems',
    {
      preHandler: requireOrgAdmin,
      schema: { tags: ['systems'], body: z.object({ name: Name, description: Description.optional() }) },
    },
    async (req, reply) => {
      const s = { id: newId(), name: req.body.name, description: req.body.description ?? null };
      await db.insert(t.systems).values({ ...s, orgId: req.user.orgId });
      return reply.code(201).header('location', `/systems/${s.id}`).send(s);
    },
  );

  r.get(
    '/systems/:systemId',
    { preHandler: requireAuth, schema: { tags: ['systems'], params: SystemParams } },
    async (req) => loadSystem(db, req.user.orgId, req.params.systemId),
  );

  r.patch(
    '/systems/:systemId',
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ['systems'],
        params: SystemParams,
        body: z.object({ name: Name.optional(), description: Description.nullable().optional() }),
      },
    },
    async (req) => {
      const { orgId } = req.user;
      await loadSystem(db, orgId, req.params.systemId);
      const { name, description } = req.body;
      if (name === undefined && description === undefined)
        throw badRequest('empty_patch', 'Nothing to update');
      await db
        .update(t.systems)
        .set({ ...(name !== undefined && { name }), ...(description !== undefined && { description }) })
        .where(and(eq(t.systems.id, req.params.systemId), eq(t.systems.orgId, orgId)));
      return loadSystem(db, orgId, req.params.systemId);
    },
  );

  /** Refuses while the system still has sources (deleting them would drop their schemas and mappings). */
  r.delete(
    '/systems/:systemId',
    { preHandler: requireOrgAdmin, schema: { tags: ['systems'], params: SystemParams } },
    async (req, reply) => {
      const { orgId } = req.user;
      await loadSystem(db, orgId, req.params.systemId);
      const [used] = await db
        .select({ n: count() })
        .from(t.sources)
        .where(eq(t.sources.systemId, req.params.systemId));
      if ((used?.n ?? 0) > 0) throw conflict('system_in_use', 'Delete the system’s sources first');
      await db
        .delete(t.systems)
        .where(and(eq(t.systems.id, req.params.systemId), eq(t.systems.orgId, orgId)));
      return reply.code(204).send();
    },
  );
}
