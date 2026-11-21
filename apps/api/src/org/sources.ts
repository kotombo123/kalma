import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { newId } from '@alerting/config';
import type { SourceConfig } from '@alerting/contracts';
import { and, asc, eq, gt, inArray, max, sql, t, type Db } from '@alerting/db';
import type { Deps } from '../deps.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { page, PageQuery } from '../lib/pagination.ts';
import { publishConfigChanged } from '../lib/config-changed.ts';
import { requireAuth, requireOrgAdmin } from '../auth/guards.ts';
import { loadSystem } from './systems.ts';
import { connectInfo, SourceFormat, SourceParserOptions, sourceConfigSchema } from './source-config.ts';

const SourceParams = z.object({ sourceId: z.string().min(1).max(64) });
const Name = z.string().trim().min(1).max(100);

/** Public columns only — the API key hash never leaves the database. */
const columns = {
  id: t.sources.id,
  systemId: t.sources.systemId,
  name: t.sources.name,
  transport: t.sources.transport,
  config: t.sources.config,
  format: t.sources.format,
  parserOptions: t.sources.parserOptions,
  enabled: t.sources.enabled,
  apiKeyPrefix: t.sources.apiKeyPrefix,
  origin: t.sources.origin,
  filePath: t.sources.filePath,
  fileError: t.sources.fileError,
  createdAt: t.sources.createdAt,
};

/** Sources from connector files (#46) change only through their file, like file-origin rules. */
function assertNotFile(s: { origin: string; filePath: string | null }) {
  if (s.origin === 'file')
    throw badRequest('file_managed', `This source is managed by ${s.filePath}; change that file instead`);
}

/**
 * Activity per source from its discovered schemas (the worker counts events there):
 * total events and the time of the last one.
 */
async function activityOf(db: Db, sourceIds: string[]) {
  if (sourceIds.length === 0) return new Map<string, { eventCount: number; lastEventAt: string | null }>();
  const rows = await db
    .select({
      sourceId: t.schemas.sourceId,
      eventCount: sql<number>`coalesce(sum(${t.schemas.eventCount}), 0)::int`,
      lastEventAt: max(t.schemas.lastSeen),
    })
    .from(t.schemas)
    .where(inArray(t.schemas.sourceId, sourceIds))
    .groupBy(t.schemas.sourceId);
  return new Map(rows.map((r) => [r.sourceId, { eventCount: r.eventCount, lastEventAt: r.lastEventAt }]));
}

const withActivity = <S extends { id: string }>(
  s: S,
  activity: Map<string, { eventCount: number; lastEventAt: string | null }>,
) => ({ ...s, ...(activity.get(s.id) ?? { eventCount: 0, lastEventAt: null }) });

/** Placeholder returned instead of secret header values; sending it back on PATCH keeps the stored value. */
export const MASK = '***';

/**
 * Poll headers usually carry upstream credentials (Authorization, X-Api-Key). They are write-only:
 * every response masks the values, for admins too (OWASP A01/A02).
 */
function present<S extends { config: SourceConfig }>(s: S): S {
  if (s.config.transport !== 'poll' || !s.config.headers) return s;
  const headers = Object.fromEntries(Object.keys(s.config.headers).map((k) => [k, MASK]));
  return { ...s, config: { ...s.config, headers } };
}

/** Keeps stored header values for keys the client sent back masked. */
function keepMaskedHeaders(next: SourceConfig, prev: SourceConfig): SourceConfig {
  if (next.transport !== 'poll' || prev.transport !== 'poll' || !next.headers) return next;
  const headers = Object.fromEntries(
    Object.entries(next.headers).map(([k, v]) => [k, v === MASK ? (prev.headers?.[k] ?? '') : v]),
  );
  return { ...next, headers };
}

/** `ak_` + 256 random bits. Stored as sha256; the first 12 chars stay visible as a hint. */
function newApiKey() {
  const key = `ak_${randomToken()}`;
  return { key, hash: sha256(key), prefix: key.slice(0, 12) };
}

async function loadSource(db: Db, orgId: string, id: string) {
  const [s] = await db
    .select(columns)
    .from(t.sources)
    .where(and(eq(t.sources.id, id), eq(t.sources.orgId, orgId)));
  if (!s) throw notFound('Source not found');
  return s;
}

export async function sourceRoutes(app: FastifyInstance, { db, redis, config }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const SourceConfigIn = sourceConfigSchema(config.fileSourceRoot);
  const changed = (orgId: string, id: string) => publishConfigChanged(redis, { kind: 'sources', orgId, id });
  const connect = (s: { id: string; config: SourceConfig }, key?: string) => connectInfo(s, config, key);

  r.get(
    '/sources',
    {
      preHandler: requireAuth,
      schema: { tags: ['sources'], querystring: PageQuery.extend({ systemId: z.string().optional() }) },
    },
    async (req) => {
      const { limit, cursor, systemId } = req.query;
      const rows = await db
        .select(columns)
        .from(t.sources)
        .where(
          and(
            eq(t.sources.orgId, req.user.orgId),
            systemId ? eq(t.sources.systemId, systemId) : undefined,
            cursor ? gt(t.sources.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(t.sources.id))
        .limit(limit + 1);
      const activity = await activityOf(
        db,
        rows.map((r) => r.id),
      );
      return page(
        rows.map((r) => withActivity(present(r), activity)),
        limit,
      );
    },
  );

  /** Returns the API key once. Afterwards only `apiKeyPrefix` is visible; use rotate-key to get a new one. */
  r.post(
    '/sources',
    {
      preHandler: requireOrgAdmin,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        tags: ['sources'],
        body: z.object({
          systemId: z.string().min(1),
          name: Name,
          config: SourceConfigIn,
          format: SourceFormat.default('auto'),
          parserOptions: SourceParserOptions.optional(),
          enabled: z.boolean().default(true),
        }),
      },
    },
    async (req, reply) => {
      const { orgId } = req.user;
      const body = req.body;
      await loadSystem(db, orgId, body.systemId);
      const id = newId();
      const key = newApiKey();
      await db.insert(t.sources).values({
        id,
        orgId,
        systemId: body.systemId,
        name: body.name,
        transport: body.config.transport,
        config: body.config,
        format: body.format,
        parserOptions: body.parserOptions ?? null,
        enabled: body.enabled,
        apiKeyHash: key.hash,
        apiKeyPrefix: key.prefix,
      });
      req.log.info({
        event: 'source_created',
        by: req.user.sub,
        sourceId: id,
        transport: body.config.transport,
      });
      await changed(orgId, id);
      const source = await loadSource(db, orgId, id);
      return reply
        .code(201)
        .header('location', `/sources/${id}`)
        .send({ source: present(source), apiKey: key.key, connect: connect(source, key.key) });
    },
  );

  r.get(
    '/sources/:sourceId',
    { preHandler: requireAuth, schema: { tags: ['sources'], params: SourceParams } },
    async (req) => {
      const source = await loadSource(db, req.user.orgId, req.params.sourceId);
      const activity = await activityOf(db, [source.id]);
      return { ...withActivity(present(source), activity), connect: connect(source) };
    },
  );

  r.patch(
    '/sources/:sourceId',
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ['sources'],
        params: SourceParams,
        body: z.object({
          name: Name.optional(),
          systemId: z.string().min(1).optional(),
          config: SourceConfigIn.optional(),
          format: SourceFormat.optional(),
          parserOptions: SourceParserOptions.nullable().optional(),
          enabled: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const { orgId } = req.user;
      const current = await loadSource(db, orgId, req.params.sourceId);
      assertNotFile(current);
      const b = req.body;
      if (Object.values(b).every((v) => v === undefined))
        throw badRequest('empty_patch', 'Nothing to update');
      if (b.config && b.config.transport !== current.transport) {
        throw badRequest('transport_change', 'Transport cannot change; create a new source instead');
      }
      if (b.systemId) await loadSystem(db, orgId, b.systemId);
      await db
        .update(t.sources)
        .set({
          ...(b.name !== undefined && { name: b.name }),
          ...(b.systemId !== undefined && { systemId: b.systemId }),
          ...(b.config !== undefined && { config: keepMaskedHeaders(b.config, current.config) }),
          ...(b.format !== undefined && { format: b.format }),
          ...(b.parserOptions !== undefined && { parserOptions: b.parserOptions }),
          ...(b.enabled !== undefined && { enabled: b.enabled }),
        })
        .where(and(eq(t.sources.id, current.id), eq(t.sources.orgId, orgId)));
      await changed(orgId, current.id);
      const source = await loadSource(db, orgId, current.id);
      return { ...present(source), connect: connect(source) };
    },
  );

  /** Invalidates the old key immediately (ingest reloads on config:changed). */
  r.post(
    '/sources/:sourceId/rotate-key',
    {
      preHandler: requireOrgAdmin,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['sources'], params: SourceParams },
    },
    async (req) => {
      const { orgId } = req.user;
      const current = await loadSource(db, orgId, req.params.sourceId);
      assertNotFile(current);
      const key = newApiKey();
      await db
        .update(t.sources)
        .set({ apiKeyHash: key.hash, apiKeyPrefix: key.prefix })
        .where(and(eq(t.sources.id, current.id), eq(t.sources.orgId, orgId)));
      req.log.info({ event: 'source_key_rotated', by: req.user.sub, sourceId: current.id });
      await changed(orgId, current.id);
      return { apiKey: key.key, apiKeyPrefix: key.prefix, connect: connect(current, key.key) };
    },
  );

  /** Also deletes the source's discovered schemas and mappings. */
  r.delete(
    '/sources/:sourceId',
    { preHandler: requireOrgAdmin, schema: { tags: ['sources'], params: SourceParams } },
    async (req, reply) => {
      const { orgId } = req.user;
      const current = await loadSource(db, orgId, req.params.sourceId);
      assertNotFile(current);
      await db.delete(t.sources).where(and(eq(t.sources.id, current.id), eq(t.sources.orgId, orgId)));
      req.log.info({ event: 'source_deleted', by: req.user.sub, sourceId: current.id });
      await changed(orgId, current.id);
      return reply.code(204).send();
    },
  );
}
