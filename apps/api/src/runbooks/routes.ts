/**
 * F-05 — runbooks: CRUD in 5 formats, parse preview (with test fill on a sample event), action catalog.
 * Parsing and filling come from @alerting/runbooks (B2); actions from @alerting/actions.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { newId } from '@alerting/config';
import { Condition, RunbookFormat, type RunbookStep } from '@alerting/contracts';
import { and, asc, eq, gt, sql, t, type Db } from '@alerting/db';
import { listActions, getAction } from '@alerting/actions';
import {
  fillRunbook,
  parseChecklist,
  parseLink,
  parseMarkdown,
  parseText,
  parseYaml,
  type ParsedRunbook,
} from '@alerting/runbooks';
import { render } from '@alerting/templates';
import type { Deps } from '../deps.ts';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors.ts';
import { page, PageQuery } from '../lib/pagination.ts';
import { publishConfigChanged } from '../lib/config-changed.ts';
import { deny, requireAuth, teamRoleOf } from '../auth/guards.ts';

const RunbookParams = z.object({ runbookId: z.string().min(1).max(64) });
const MAX_SOURCE = 64 * 1024;
const Body = z.object({
  teamId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  format: RunbookFormat,
  source: z.string().min(1).max(MAX_SOURCE),
});
type Body = z.infer<typeof Body>;

/** `{ type: WORKFLOW_FAILED, "error.code": TIMEOUT }` (YAML shorthand) or a full Condition. */
function toCondition(raw: unknown): Condition | undefined {
  if (raw === undefined || raw === null) return undefined;
  const full = Condition.safeParse(raw);
  if (full.success) return full.data;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      all: Object.entries(raw as Record<string, unknown>).map(([field, value]) => ({
        field,
        op: 'eq' as const,
        value,
      })),
    };
  }
  return undefined;
}

export interface Parsed {
  steps: RunbookStep[];
  matches?: Condition;
  warnings: string[];
}

/** Source text → steps. Errors in the source become a 400 with the parser's message. */
export function parseRunbook(format: Body['format'], source: string): Parsed {
  // the link becomes an <a href> in the UI: only http(s), never javascript: / data: (stored XSS)
  if (format === 'link' && !/^https?:\/\/\S+$/i.test(source.trim())) {
    throw badRequest('runbook_invalid', 'Link must be an http:// or https:// address');
  }
  let r: ParsedRunbook;
  try {
    r =
      format === 'yaml'
        ? parseYaml(source)
        : format === 'markdown'
          ? parseMarkdown(source)
          : format === 'checklist'
            ? parseChecklist(source)
            : format === 'link'
              ? parseLink(source.trim())
              : parseText(source);
  } catch (e) {
    throw badRequest('runbook_invalid', (e as Error).message);
  }
  const warnings = [...r.warnings];
  for (const [i, s] of r.steps.entries()) {
    if (!s.action) continue;
    const a = getAction(s.action.type);
    if (!a) warnings.push(`Krok ${i + 1}: nieznana akcja „${s.action.type}”`);
    else if (a.risk === 'high' && s.approval !== 'required') {
      warnings.push(`Krok ${i + 1}: akcja „${a.name}” ma wysokie ryzyko — zawsze poprosimy o zatwierdzenie`);
    }
  }
  return { steps: r.steps, matches: toCondition(r.matchesRaw), warnings };
}

async function loadRunbook(db: Db, orgId: string, id: string) {
  const [rb] = await db
    .select({
      id: t.runbooks.id,
      teamId: t.runbooks.teamId,
      teamName: t.teams.name,
      name: t.runbooks.name,
      format: t.runbooks.format,
      source: t.runbooks.source,
      matches: t.runbooks.matches,
      steps: t.runbooks.steps,
      version: t.runbooks.version,
      updatedAt: t.runbooks.updatedAt,
    })
    .from(t.runbooks)
    .innerJoin(t.teams, eq(t.teams.id, t.runbooks.teamId))
    .where(and(eq(t.runbooks.id, id), eq(t.runbooks.orgId, orgId)));
  if (!rb) throw notFound('Runbook not found');
  return rb;
}

/** Org admin, or lead of every given team. */
async function requireWriter(db: Db, req: FastifyRequest, teamIds: string[]) {
  if (req.user.role === 'admin') return;
  for (const teamId of new Set(teamIds)) {
    if ((await teamRoleOf(db, req.user.orgId, teamId, req.user.sub)) !== 'lead') {
      throw deny(req, 'Org admin or lead of the runbook’s team required');
    }
  }
}

async function requireTeamInOrg(db: Db, orgId: string, teamId: string) {
  const [team] = await db
    .select({ id: t.teams.id })
    .from(t.teams)
    .where(and(eq(t.teams.id, teamId), eq(t.teams.orgId, orgId)));
  if (!team)
    throw new HttpError(400, 'runbook_invalid', 'Team not found', [
      { path: ['body', 'teamId'], message: 'Team not found' },
    ]);
}

export async function runbookRoutes(app: FastifyInstance, { db, redis }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const changed = (orgId: string, id: string, version: number) =>
    publishConfigChanged(redis, { kind: 'runbooks', orgId, id, version });

  r.get(
    '/runbooks/actions',
    {
      preHandler: requireAuth,
      schema: { tags: ['runbooks'], summary: 'Action types a runbook step can use' },
    },
    async () => ({
      data: listActions()
        .map((a) => ({ name: a.name, title: a.title, risk: a.risk }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }),
  );

  r.get(
    '/runbooks',
    {
      preHandler: requireAuth,
      schema: { tags: ['runbooks'], querystring: PageQuery.extend({ teamId: z.string().optional() }) },
    },
    async (req) => {
      const { limit, cursor, teamId } = req.query;
      const rows = await db
        .select({
          id: t.runbooks.id,
          teamId: t.runbooks.teamId,
          teamName: t.teams.name,
          name: t.runbooks.name,
          format: t.runbooks.format,
          stepCount: sql<number>`jsonb_array_length(${t.runbooks.steps})::int`,
          version: t.runbooks.version,
          updatedAt: t.runbooks.updatedAt,
        })
        .from(t.runbooks)
        .innerJoin(t.teams, eq(t.teams.id, t.runbooks.teamId))
        .where(
          and(
            eq(t.runbooks.orgId, req.user.orgId),
            teamId ? eq(t.runbooks.teamId, teamId) : undefined,
            cursor ? gt(t.runbooks.id, cursor) : undefined,
          ),
        )
        .orderBy(asc(t.runbooks.id))
        .limit(limit + 1);
      return page(rows, limit);
    },
  );

  r.get(
    '/runbooks/:runbookId',
    { preHandler: requireAuth, schema: { tags: ['runbooks'], params: RunbookParams } },
    async (req) => loadRunbook(db, req.user.orgId, req.params.runbookId),
  );

  /** Steps a source produces, plus an optional test fill on sample event fields. Nothing is saved. */
  r.post(
    '/runbooks/parse',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['runbooks'],
        body: Body.pick({ format: true, source: true }).extend({
          sample: z.record(z.string(), z.unknown()).optional(),
        }),
      },
    },
    async (req) => {
      const parsed = parseRunbook(req.body.format, req.body.source);
      const filled = req.body.sample
        ? fillRunbook(parsed.steps, req.body.sample, { renderTemplate: (tpl, data) => render(tpl, data) })
        : undefined;
      const risk = (s: RunbookStep) => (s.action ? (getAction(s.action.type)?.risk ?? null) : null);
      return { ...parsed, steps: parsed.steps.map((s) => ({ ...s, risk: risk(s) })), filled };
    },
  );

  r.post(
    '/runbooks',
    { preHandler: requireAuth, schema: { tags: ['runbooks'], body: Body } },
    async (req, reply) => {
      const { orgId, sub } = req.user;
      const body = req.body;
      await requireTeamInOrg(db, orgId, body.teamId);
      await requireWriter(db, req, [body.teamId]);
      const parsed = parseRunbook(body.format, body.source);
      const id = newId();
      await db.insert(t.runbooks).values({
        id,
        orgId,
        teamId: body.teamId,
        name: body.name,
        format: body.format,
        source: body.source,
        matches: parsed.matches ?? null,
        steps: parsed.steps,
        version: 1,
      });
      req.log.info({ event: 'runbook_created', by: sub, runbookId: id });
      await changed(orgId, id, 1);
      return reply
        .code(201)
        .header('location', `/runbooks/${id}`)
        .send({ ...(await loadRunbook(db, orgId, id)), warnings: parsed.warnings });
    },
  );

  r.put(
    '/runbooks/:runbookId',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['runbooks'],
        params: RunbookParams,
        body: Body.extend({ version: z.number().int().optional() }),
      },
    },
    async (req) => {
      const { orgId } = req.user;
      const { version: expected, ...body } = req.body;
      const current = await loadRunbook(db, orgId, req.params.runbookId);
      await requireTeamInOrg(db, orgId, body.teamId);
      await requireWriter(db, req, [current.teamId, body.teamId]);
      if (expected !== undefined && expected !== current.version) {
        throw conflict(
          'version_conflict',
          `The runbook changed meanwhile (now version ${current.version}); reload and retry`,
        );
      }
      const parsed = parseRunbook(body.format, body.source);
      const version = current.version + 1;
      const [done] = await db
        .update(t.runbooks)
        .set({
          teamId: body.teamId,
          name: body.name,
          format: body.format,
          source: body.source,
          matches: parsed.matches ?? null,
          steps: parsed.steps,
          version,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(t.runbooks.id, current.id),
            eq(t.runbooks.orgId, orgId),
            eq(t.runbooks.version, current.version),
          ),
        )
        .returning({ id: t.runbooks.id });
      if (!done) throw conflict('version_conflict', 'The runbook changed meanwhile; reload and retry');
      await changed(orgId, current.id, version);
      return { ...(await loadRunbook(db, orgId, current.id)), warnings: parsed.warnings };
    },
  );

  /** Refused while rules still point at it (alerts of those rules would lose their instructions). */
  r.delete(
    '/runbooks/:runbookId',
    { preHandler: requireAuth, schema: { tags: ['runbooks'], params: RunbookParams } },
    async (req, reply) => {
      const { orgId } = req.user;
      const current = await loadRunbook(db, orgId, req.params.runbookId);
      await requireWriter(db, req, [current.teamId]);
      const used = await db
        .select({ id: t.rules.id, name: t.rules.name })
        .from(t.rules)
        .where(and(eq(t.rules.orgId, orgId), sql`${t.rules.definition}->>'runbookId' = ${current.id}`))
        .limit(5);
      if (used.length) {
        throw conflict('runbook_in_use', `Used by rules: ${used.map((u) => u.name).join(', ')}`);
      }
      await db.delete(t.runbooks).where(and(eq(t.runbooks.id, current.id), eq(t.runbooks.orgId, orgId)));
      await changed(orgId, current.id, current.version + 1);
      return reply.code(204).send();
    },
  );
}
