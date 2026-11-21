/**
 * F-03 — discovered schemas and their mappings (the "new schema" tile and mapping wizard).
 * Uses the pure B1 packages (`@alerting/parsing`, `@alerting/schema`) for parsing, guessing and previews.
 */
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { newId } from '@alerting/config';
import { Mapping, ParserOptions, SchemaStatus, type GuessedRoles } from '@alerting/contracts';
import { and, desc, eq, lt, max, t, type Db } from '@alerting/db';
import { parse } from '@alerting/parsing';
import {
  describeFields,
  detectPreset,
  fingerprint,
  flatten,
  guessRoles,
  matchPresets,
  normalize,
  PRESETS,
} from '@alerting/schema';
import type { Deps } from '../deps.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { recentEvents } from '../lib/recent-events.ts';
import { page, PageQuery } from '../lib/pagination.ts';
import { publishConfigChanged } from '../lib/config-changed.ts';
import { deny, requireAuth } from '../auth/guards.ts';
import { SourceFormat } from '../org/source-config.ts';

const SchemaParams = z.object({ schemaId: z.string().min(1).max(64) });
/** Body of POST /schemas/:id/mapping and the draft mapping of a preview. */
const MappingInput = Mapping.pick({ roles: true, severityMap: true, resolvedValues: true, presetId: true });
type MappingInput = z.infer<typeof MappingInput>;
const PREVIEW_EVENTS = 20;
const MAX_TEST_BODY = 256 * 1024;

const listColumns = {
  id: t.schemas.id,
  name: t.schemas.name,
  status: t.schemas.status,
  fingerprint: t.schemas.fingerprint,
  sourceId: t.schemas.sourceId,
  sourceName: t.sources.name,
  eventCount: t.schemas.eventCount,
  unmatchedCount: t.schemas.unmatchedCount,
  firstSeen: t.schemas.firstSeen,
  lastSeen: t.schemas.lastSeen,
  sample: t.schemas.sample,
  guessedRoles: t.schemas.guessedRoles,
  fields: t.schemas.fields,
  mappingId: t.schemas.mappingId,
};

/** Admins and team leads change mappings; members can look. */
function requireMapper(db: Db): preHandlerAsyncHookHandler {
  return async function (req, reply) {
    await requireAuth.call(this, req, reply);
    if (req.user.role === 'admin') return;
    const [lead] = await db
      .select({ teamId: t.teamMembers.teamId })
      .from(t.teamMembers)
      .innerJoin(t.teams, eq(t.teams.id, t.teamMembers.teamId))
      .where(
        and(
          eq(t.teamMembers.userId, req.user.sub),
          eq(t.teams.orgId, req.user.orgId),
          eq(t.teamMembers.role, 'lead'),
        ),
      )
      .limit(1);
    if (!lead) throw deny(req, 'Org admin or team lead required');
  };
}

async function loadSchema(db: Db, orgId: string, id: string) {
  const [s] = await db
    .select(listColumns)
    .from(t.schemas)
    .innerJoin(t.sources, eq(t.sources.id, t.schemas.sourceId))
    .where(and(eq(t.schemas.id, id), eq(t.schemas.orgId, orgId)));
  if (!s) throw notFound('Schema not found');
  return s;
}

/** Known format (B1-05 presets) for a flat record: the best match with a ready mapping, plus alternatives. */
function presetInfo(flat: ReturnType<typeof flatten>) {
  const best = detectPreset(flat);
  return {
    preset: best ? { id: best.preset.id, name: best.preset.name, mapping: best.mapping } : null,
    presetAlternatives: matchPresets(flat)
      .slice(1)
      .map((p) => ({ id: p.id, name: p.name })),
  };
}

/**
 * Fields and guesses come from the worker; fill them from the sample when it did not store them.
 * Adds the detected preset ("Recognized: Alertmanager").
 */
function withAnalysis<S extends { sample: unknown; fields: unknown[]; guessedRoles: GuessedRoles }>(s: S) {
  const flat = flatten(s.sample ?? {});
  return {
    ...s,
    fields: s.fields.length > 0 ? s.fields : describeFields(flat),
    guessedRoles: Object.keys(s.guessedRoles).length > 0 ? s.guessedRoles : guessRoles(flat),
    ...presetInfo(flat),
  };
}

async function latestMapping(db: Db, schemaId: string) {
  const [m] = await db
    .select()
    .from(t.mappings)
    .where(eq(t.mappings.schemaId, schemaId))
    .orderBy(desc(t.mappings.version))
    .limit(1);
  return m ?? null;
}

/** DB row (nullable columns) → the mapping shape `normalize` takes. */
function asMappingInput(m: NonNullable<Awaited<ReturnType<typeof latestMapping>>>): MappingInput {
  return {
    roles: m.roles,
    severityMap: m.severityMap ?? undefined,
    resolvedValues: m.resolvedValues ?? undefined,
    presetId: m.presetId ?? undefined,
  };
}

/** Role paths that do not exist in the schema — saved anyway (fields can be optional), returned as warnings. */
function unknownPaths(mapping: MappingInput, fields: { path: string }[]) {
  const known = new Set(fields.map((f) => f.path));
  return Object.entries(mapping.roles)
    .filter(([, b]) => b?.path !== undefined && !known.has(b.path))
    .map(([role, b]) => `${role}: field "${b!.path}" is not in this schema`);
}

export async function schemaRoutes(app: FastifyInstance, { db, redis }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/schemas',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['schemas'],
        summary: 'Discovered schemas; `status=new` feeds the "New schema" tiles',
        querystring: PageQuery.extend({ status: SchemaStatus.optional(), sourceId: z.string().optional() }),
      },
    },
    async (req) => {
      const { limit, cursor, status, sourceId } = req.query;
      const rows = await db
        .select(listColumns)
        .from(t.schemas)
        .innerJoin(t.sources, eq(t.sources.id, t.schemas.sourceId))
        .where(
          and(
            eq(t.schemas.orgId, req.user.orgId),
            status ? eq(t.schemas.status, status) : undefined,
            sourceId ? eq(t.schemas.sourceId, sourceId) : undefined,
            cursor ? lt(t.schemas.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(t.schemas.id))
        .limit(limit + 1);
      return page(rows.map(withAnalysis), limit);
    },
  );

  r.get(
    '/schemas/presets',
    {
      preHandler: requireAuth,
      schema: { tags: ['schemas'], summary: 'Built-in formats (Alertmanager, CloudEvents, …)' },
    },
    async () => ({ data: PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description })) }),
  );

  r.get(
    '/schemas/:schemaId',
    { preHandler: requireAuth, schema: { tags: ['schemas'], params: SchemaParams } },
    async (req) => {
      const s = withAnalysis(await loadSchema(db, req.user.orgId, req.params.schemaId));
      return { ...s, mapping: await latestMapping(db, s.id) };
    },
  );

  r.patch(
    '/schemas/:schemaId',
    {
      preHandler: requireMapper(db),
      schema: {
        tags: ['schemas'],
        params: SchemaParams,
        body: z.object({
          name: z.string().trim().min(1).max(100).optional(),
          status: SchemaStatus.optional(),
        }),
      },
    },
    async (req) => {
      const { orgId } = req.user;
      const s = await loadSchema(db, orgId, req.params.schemaId);
      const { name, status } = req.body;
      if (name === undefined && status === undefined) throw badRequest('empty_patch', 'Nothing to update');
      if (status === 'mapped' && !s.mappingId) throw badRequest('no_mapping', 'Save a mapping first');
      await db
        .update(t.schemas)
        .set({ ...(name !== undefined && { name }), ...(status !== undefined && { status }) })
        .where(and(eq(t.schemas.id, s.id), eq(t.schemas.orgId, orgId)));
      await publishConfigChanged(redis, { kind: 'schemas', orgId, id: s.id });
      return withAnalysis(await loadSchema(db, orgId, s.id));
    },
  );

  r.get(
    '/schemas/:schemaId/mappings',
    {
      preHandler: requireAuth,
      schema: { tags: ['schemas'], summary: 'Mapping versions, newest first', params: SchemaParams },
    },
    async (req) => {
      await loadSchema(db, req.user.orgId, req.params.schemaId);
      const data = await db
        .select()
        .from(t.mappings)
        .where(eq(t.mappings.schemaId, req.params.schemaId))
        .orderBy(desc(t.mappings.version));
      return { data };
    },
  );

  /** Saves a new mapping version, marks the schema `mapped`; the worker reloads on config:changed. */
  r.post(
    '/schemas/:schemaId/mapping',
    {
      preHandler: requireMapper(db),
      schema: {
        tags: ['schemas'],
        params: SchemaParams,
        body: MappingInput.extend({ name: z.string().trim().min(1).max(100).optional() }),
      },
    },
    async (req, reply) => {
      const { orgId, sub } = req.user;
      const s = withAnalysis(await loadSchema(db, orgId, req.params.schemaId));
      const { name, ...mapping } = req.body;
      const id = newId();
      const version = await db.transaction(async (tx) => {
        const [cur] = await tx
          .select({ v: max(t.mappings.version) })
          .from(t.mappings)
          .where(eq(t.mappings.schemaId, s.id));
        const v = (cur?.v ?? 0) + 1;
        await tx.insert(t.mappings).values({
          id,
          schemaId: s.id,
          version: v,
          roles: mapping.roles,
          severityMap: mapping.severityMap ?? null,
          resolvedValues: mapping.resolvedValues ?? null,
          presetId: mapping.presetId ?? null,
          createdBy: sub,
        });
        await tx
          .update(t.schemas)
          .set({ mappingId: id, status: 'mapped', ...(name !== undefined && { name }) })
          .where(and(eq(t.schemas.id, s.id), eq(t.schemas.orgId, orgId)));
        return v;
      });
      await publishConfigChanged(redis, { kind: 'mappings', orgId, id: s.id, version });
      return reply.code(201).send({
        mapping: { id, schemaId: s.id, version, ...mapping },
        warnings: unknownPaths(mapping, s.fields),
      });
    },
  );

  /**
   * Live preview for the mapping wizard: the draft mapping applied to the schema sample and the
   * last events of this schema (from `events:recent:{orgId}`). Nothing is saved.
   */
  r.post(
    '/schemas/:schemaId/preview',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['schemas'],
        params: SchemaParams,
        body: z.object({ mapping: MappingInput.optional() }),
      },
    },
    async (req) => {
      const { orgId } = req.user;
      const s = withAnalysis(await loadSchema(db, orgId, req.params.schemaId));
      // draft → saved mapping → detected preset → guessed roles (inside normalize)
      const saved = req.body.mapping ? null : await latestMapping(db, s.id);
      const mapping = req.body.mapping ?? (saved ? asMappingInput(saved) : (s.preset?.mapping ?? undefined));
      const now = new Date();

      const recent = await recentEvents(redis, orgId, {
        filter: (e) => e.schemaId === s.id,
        limit: PREVIEW_EVENTS,
      });

      const apply = (e: { id: string; raw: unknown; receivedAt: string; ingestTs: number }) =>
        normalize({
          envelope: {
            id: e.id,
            orgId,
            sourceId: s.sourceId,
            ingestTs: e.ingestTs,
            receivedAt: e.receivedAt,
            raw: e.raw,
          },
          schemaId: s.id,
          fingerprint: s.fingerprint,
          flat: flatten(e.raw),
          mapping,
        });
      return {
        sample: apply({
          id: 'sample',
          raw: s.sample ?? {},
          receivedAt: now.toISOString(),
          ingestTs: now.getTime(),
        }),
        events: recent.map(apply),
        warnings: mapping ? unknownPaths(mapping, s.fields) : [],
      };
    },
  );

  /**
   * "Paste your own example": parse a body like ingest would, then fingerprint, describe and guess
   * roles. Says whether the schema is already known. Nothing is saved.
   */
  r.post(
    '/schemas/test',
    {
      preHandler: requireAuth,
      bodyLimit: MAX_TEST_BODY + 4096,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        tags: ['schemas'],
        body: z.object({
          body: z.string().min(1).max(MAX_TEST_BODY),
          contentType: z.string().max(200).optional(),
          format: SourceFormat.optional(),
          parserOptions: ParserOptions.optional(),
        }),
      },
    },
    async (req) => {
      let parsed;
      try {
        parsed = parse(req.body);
      } catch {
        throw badRequest('parse_failed', 'Could not parse the example');
      }
      const first = parsed.records[0] ?? {};
      const flat = flatten(first);
      const fp = fingerprint(flat);
      const [known] = await db
        .select({ id: t.schemas.id, name: t.schemas.name, status: t.schemas.status })
        .from(t.schemas)
        .where(and(eq(t.schemas.orgId, req.user.orgId), eq(t.schemas.fingerprint, fp)));
      const now = new Date();
      return {
        format: parsed.format,
        parseError: parsed.parseError,
        recordCount: parsed.records.length,
        fingerprint: fp,
        knownSchema: known ?? null,
        fields: describeFields(flat),
        guessedRoles: guessRoles(flat),
        ...presetInfo(flat),
        normalized: normalize({
          envelope: {
            id: 'test',
            orgId: req.user.orgId,
            sourceId: 'test',
            ingestTs: now.getTime(),
            receivedAt: now.toISOString(),
            raw: first,
          },
          schemaId: known?.id ?? 'test',
          fingerprint: fp,
          flat,
        }),
      };
    },
  );
}
