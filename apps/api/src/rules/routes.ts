/**
 * F-04 — rules: CRUD, versions, diff, rollback, validation, YAML export.
 * Rules from `config/rules/*.yaml` (origin `file`) are read-only here: the YAML sync owns them.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { stringify } from 'yaml';
import { newId } from '@alerting/config';
import { Condition, Rule, type RoutingTarget } from '@alerting/contracts';
import { preview } from '@alerting/rules';
import { and, desc, eq, inArray, lt, t, type Db } from '@alerting/db';
import type { Deps } from '../deps.ts';
import { conflict, HttpError, notFound } from '../lib/errors.ts';
import { page, PageQuery } from '../lib/pagination.ts';
import { publishConfigChanged } from '../lib/config-changed.ts';
import { deny, requireAuth, teamRoleOf } from '../auth/guards.ts';
import { diff } from './diff.ts';
import { checkCondition, checkReferences, checkTemplates, knownFields, type Issue } from './validate.ts';
import { recentEvents } from '../lib/recent-events.ts';

const RuleParams = z.object({ ruleId: z.string().min(1).max(64) });
/** What clients send: a `Rule` without server-owned fields. */
const RuleBody = Rule.omit({ id: true, orgId: true, version: true, origin: true });
type RuleBody = z.infer<typeof RuleBody>;

const summary = {
  id: t.rules.id,
  teamId: t.rules.teamId,
  teamName: t.teams.name,
  name: t.rules.name,
  enabled: t.rules.enabled,
  version: t.rules.version,
  origin: t.rules.origin,
  filePath: t.rules.filePath,
  fileError: t.rules.fileError,
  updatedBy: t.rules.updatedBy,
  updatedAt: t.rules.updatedAt,
  definition: t.rules.definition,
};

async function loadRule(db: Db, orgId: string, id: string) {
  const [r] = await db
    .select(summary)
    .from(t.rules)
    .innerJoin(t.teams, eq(t.teams.id, t.rules.teamId))
    .where(and(eq(t.rules.id, id), eq(t.rules.orgId, orgId)));
  if (!r) throw notFound('Rule not found');
  return r;
}

/** Org admin, or lead of every given team. */
async function requireRuleWriter(db: Db, req: FastifyRequest, teamIds: string[]) {
  if (req.user.role === 'admin') return;
  for (const teamId of new Set(teamIds)) {
    if ((await teamRoleOf(db, req.user.orgId, teamId, req.user.sub)) !== 'lead') {
      throw deny(req, 'Org admin or lead of the rule’s team required');
    }
  }
}

function assertEditable(rule: { origin: string; filePath: string | null }) {
  if (rule.origin === 'file') {
    throw conflict(
      'read_only',
      `This rule comes from ${rule.filePath ?? 'a YAML file'}; edit the file instead`,
    );
  }
}

const ruleInvalid = (issues: Issue[]) => new HttpError(400, 'rule_invalid', 'The rule has errors', issues);

export async function ruleRoutes(app: FastifyInstance, { db, redis }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const changed = (orgId: string, id: string, version: number) =>
    publishConfigChanged(redis, { kind: 'rules', orgId, id, version });

  /** Full validation: structure (Zod, already done by the route schema), references, operators. */
  async function validate(orgId: string, body: RuleBody) {
    const [refs, cond] = await Promise.all([
      checkReferences(db, orgId, body),
      knownFields(db, orgId).then((f) => checkCondition(body.condition, f)),
    ]);
    return { issues: [...refs, ...cond.issues, ...checkTemplates(body)], warnings: cond.warnings };
  }

  async function validOrThrow(orgId: string, body: RuleBody) {
    const v = await validate(orgId, body);
    if (v.issues.length) throw ruleInvalid(v.issues);
    return v.warnings;
  }

  r.get(
    '/rules',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['rules'],
        querystring: PageQuery.extend({
          teamId: z.string().optional(),
          origin: z.enum(['ui', 'api', 'file']).optional(),
          enabled: z.enum(['true', 'false']).optional(),
        }),
      },
    },
    async (req) => {
      const { limit, cursor, teamId, origin, enabled } = req.query;
      const rows = await db
        .select(summary)
        .from(t.rules)
        .innerJoin(t.teams, eq(t.teams.id, t.rules.teamId))
        .where(
          and(
            eq(t.rules.orgId, req.user.orgId),
            teamId ? eq(t.rules.teamId, teamId) : undefined,
            origin ? eq(t.rules.origin, origin) : undefined,
            enabled ? eq(t.rules.enabled, enabled === 'true') : undefined,
            cursor ? lt(t.rules.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(t.rules.id))
        .limit(limit + 1);
      return page(rows, limit);
    },
  );

  r.post(
    '/rules/validate',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['rules'],
        summary: 'Check a rule without saving it',
        body: z.object({ rule: z.unknown() }),
      },
    },
    async (req) => {
      const parsed = RuleBody.safeParse(req.body.rule);
      if (!parsed.success) {
        return {
          valid: false,
          issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
          warnings: [],
        };
      }
      const v = await validate(req.user.orgId, parsed.data);
      return { valid: v.issues.length === 0, ...v };
    },
  );

  r.post(
    '/rules',
    { preHandler: requireAuth, schema: { tags: ['rules'], body: RuleBody } },
    async (req, reply) => {
      const { orgId, sub } = req.user;
      const body = req.body;
      await requireRuleWriter(db, req, [body.teamId]);
      const warnings = await validOrThrow(orgId, body);
      const id = newId();
      const rule = Rule.parse({ ...body, id, orgId, version: 1, origin: 'ui' });
      await db.transaction(async (tx) => {
        await tx.insert(t.rules).values({
          id,
          orgId,
          teamId: rule.teamId,
          name: rule.name,
          enabled: rule.enabled,
          version: 1,
          definition: rule,
          origin: 'ui',
          updatedBy: sub,
        });
        await tx.insert(t.ruleVersions).values({ ruleId: id, version: 1, definition: rule, authorId: sub });
      });
      await changed(orgId, id, 1);
      return reply
        .code(201)
        .header('location', `/rules/${id}`)
        .send({ ...(await loadRule(db, orgId, id)), warnings });
    },
  );

  r.get(
    '/rules/:ruleId',
    { preHandler: requireAuth, schema: { tags: ['rules'], params: RuleParams } },
    async (req) => loadRule(db, req.user.orgId, req.params.ruleId),
  );

  /** Saves `definition` as version n+1. Optimistic locking: `version` must be the version the client edited. */
  async function saveVersion(
    req: FastifyRequest,
    ruleId: string,
    body: RuleBody,
    expected: number | undefined,
  ) {
    const { orgId, sub } = req.user;
    const current = await loadRule(db, orgId, ruleId);
    assertEditable(current);
    await requireRuleWriter(db, req, [current.teamId, body.teamId]);
    if (expected !== undefined && expected !== current.version) {
      throw conflict(
        'version_conflict',
        `The rule changed meanwhile (now version ${current.version}); reload and retry`,
      );
    }
    const warnings = await validOrThrow(orgId, body);
    const version = current.version + 1;
    const rule = Rule.parse({ ...body, id: ruleId, orgId, version, origin: current.origin });
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(t.rules)
        .set({
          teamId: rule.teamId,
          name: rule.name,
          enabled: rule.enabled,
          version,
          definition: rule,
          updatedBy: sub,
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(t.rules.id, ruleId), eq(t.rules.orgId, orgId), eq(t.rules.version, current.version)))
        .returning({ id: t.rules.id });
      if (rows.length === 0) return false;
      await tx.insert(t.ruleVersions).values({ ruleId, version, definition: rule, authorId: sub });
      return true;
    });
    if (!updated) throw conflict('version_conflict', 'The rule changed meanwhile; reload and retry');
    await changed(orgId, ruleId, version);
    return { ...(await loadRule(db, orgId, ruleId)), warnings };
  }

  r.put(
    '/rules/:ruleId',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['rules'],
        summary: 'Replace the rule (new version)',
        params: RuleParams,
        body: RuleBody.extend({ version: z.number().int().optional() }),
      },
    },
    async (req) => {
      const { version, ...body } = req.body;
      return saveVersion(req, req.params.ruleId, body, version);
    },
  );

  r.patch(
    '/rules/:ruleId',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['rules'],
        summary: 'Enable / disable',
        params: RuleParams,
        body: z.object({ enabled: z.boolean() }),
      },
    },
    async (req) => {
      const current = await loadRule(db, req.user.orgId, req.params.ruleId);
      const def = RuleBody.parse(current.definition);
      return saveVersion(req, current.id, { ...def, enabled: req.body.enabled }, undefined);
    },
  );

  r.delete(
    '/rules/:ruleId',
    { preHandler: requireAuth, schema: { tags: ['rules'], params: RuleParams } },
    async (req, reply) => {
      const { orgId } = req.user;
      const current = await loadRule(db, orgId, req.params.ruleId);
      assertEditable(current);
      await requireRuleWriter(db, req, [current.teamId]);
      await db.delete(t.rules).where(and(eq(t.rules.id, current.id), eq(t.rules.orgId, orgId)));
      req.log.info({ event: 'rule_deleted', by: req.user.sub, ruleId: current.id });
      await changed(orgId, current.id, current.version + 1);
      return reply.code(204).send();
    },
  );

  r.get(
    '/rules/:ruleId/versions',
    { preHandler: requireAuth, schema: { tags: ['rules'], params: RuleParams } },
    async (req) => {
      await loadRule(db, req.user.orgId, req.params.ruleId);
      const data = await db
        .select({
          version: t.ruleVersions.version,
          authorId: t.ruleVersions.authorId,
          authorName: t.users.name,
          createdAt: t.ruleVersions.createdAt,
        })
        .from(t.ruleVersions)
        .leftJoin(t.users, eq(t.users.id, t.ruleVersions.authorId))
        .where(eq(t.ruleVersions.ruleId, req.params.ruleId))
        .orderBy(desc(t.ruleVersions.version));
      return { data };
    },
  );

  async function versionsOf(ruleId: string, versions: number[]) {
    const rows = await db
      .select({ version: t.ruleVersions.version, definition: t.ruleVersions.definition })
      .from(t.ruleVersions)
      .where(and(eq(t.ruleVersions.ruleId, ruleId), inArray(t.ruleVersions.version, versions)));
    const byVersion = new Map(rows.map((x) => [x.version, x.definition]));
    for (const v of versions) if (!byVersion.has(v)) throw notFound(`Version ${v} not found`);
    return byVersion;
  }

  r.get(
    '/rules/:ruleId/versions/:version',
    {
      preHandler: requireAuth,
      schema: { tags: ['rules'], params: RuleParams.extend({ version: z.coerce.number().int().min(1) }) },
    },
    async (req) => {
      await loadRule(db, req.user.orgId, req.params.ruleId);
      const defs = await versionsOf(req.params.ruleId, [req.params.version]);
      return { version: req.params.version, definition: defs.get(req.params.version) };
    },
  );

  r.get(
    '/rules/:ruleId/diff',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['rules'],
        summary: 'Changed fields between two versions (default: previous → current)',
        params: RuleParams,
        querystring: z.object({
          from: z.coerce.number().int().min(1).optional(),
          to: z.coerce.number().int().min(1).optional(),
        }),
      },
    },
    async (req) => {
      const current = await loadRule(db, req.user.orgId, req.params.ruleId);
      const to = req.query.to ?? current.version;
      const from = req.query.from ?? Math.max(1, to - 1);
      const defs = await versionsOf(current.id, [from, to]);
      const strip = (d: unknown) => {
        const { version: _v, ...rest } = d as Record<string, unknown>;
        return rest;
      };
      return { from, to, changes: diff(strip(defs.get(from)), strip(defs.get(to))) };
    },
  );

  r.post(
    '/rules/:ruleId/rollback',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['rules'],
        summary: 'Restore an old version as a new version',
        params: RuleParams,
        body: z.object({ version: z.number().int().min(1) }),
      },
    },
    async (req) => {
      const defs = await versionsOf((await loadRule(db, req.user.orgId, req.params.ruleId)).id, [
        req.body.version,
      ]);
      const old = RuleBody.parse(defs.get(req.body.version));
      return saveVersion(req, req.params.ruleId, old, undefined);
    },
  );

  /** The rule as a `config/rules/*.yaml` file: teams, users and runbooks by name / email. */
  r.get(
    '/rules/:ruleId/yaml',
    { preHandler: requireAuth, schema: { tags: ['rules'], params: RuleParams } },
    async (req, reply) => {
      const { orgId } = req.user;
      const rule = await loadRule(db, orgId, req.params.ruleId);
      const def = Rule.parse(rule.definition);
      const teamIds = [def.teamId, ...def.routing.targets.flatMap((x) => ('teamId' in x ? [x.teamId] : []))];
      const userIds = def.routing.targets.flatMap((x) => ('userId' in x ? [x.userId] : []));
      const [teams, users, runbooks] = await Promise.all([
        db
          .select({ id: t.teams.id, name: t.teams.name })
          .from(t.teams)
          .where(and(eq(t.teams.orgId, orgId), inArray(t.teams.id, teamIds))),
        userIds.length
          ? db
              .select({ id: t.users.id, email: t.users.email })
              .from(t.users)
              .innerJoin(t.memberships, eq(t.memberships.userId, t.users.id))
              .where(and(eq(t.memberships.orgId, orgId), inArray(t.users.id, userIds)))
          : [],
        def.runbookId
          ? db
              .select({ name: t.runbooks.name })
              .from(t.runbooks)
              .where(and(eq(t.runbooks.orgId, orgId), eq(t.runbooks.id, def.runbookId)))
          : [],
      ]);
      const teamName = new Map(teams.map((x) => [x.id, x.name.toLowerCase().replace(/\s+/g, '-')]));
      const email = new Map(users.map((x) => [x.id, x.email]));
      const targets = def.routing.targets.map((x: RoutingTarget) =>
        'teamId' in x
          ? { type: x.type, team: teamName.get(x.teamId) ?? x.teamId }
          : { type: 'user', email: email.get(x.userId) ?? x.userId },
      );
      const { id: _i, orgId: _o, version: _v, teamId, runbookId: _r, origin: _g, name, ...rest } = def;
      const file = {
        name,
        team: teamName.get(teamId) ?? teamId,
        ...rest,
        routing: { ...rest.routing, targets },
        ...(runbooks[0] && { runbook: runbooks[0].name }),
        origin: 'file',
      };
      const slug =
        rule.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'rule';
      return reply
        .header('content-type', 'application/yaml; charset=utf-8')
        .header('content-disposition', `attachment; filename="${slug}.yaml"`)
        .send(stringify(file));
    },
  );

  /**
   * "Would catch X of the last 1000": the draft condition (+ optional scope) run by @alerting/rules
   * over `events:recent:{orgId}`. Invalid conditions return their issues instead of a count.
   */
  r.post(
    '/rules/preview',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['rules'],
        body: z.object({
          condition: Condition,
          scope: Rule.shape.scope,
          maxExamples: z.number().int().min(0).max(20).default(5),
        }),
      },
    },
    async (req) => {
      const { condition, scope, maxExamples } = req.body;
      const { orgId } = req.user;
      const { issues } = checkCondition(condition, await knownFields(db, orgId));
      if (issues.length) throw ruleInvalid(issues);
      const inScope = (e: { sourceId: string; schemaId: string }) =>
        (!scope?.sourceIds?.length || scope.sourceIds.includes(e.sourceId)) &&
        (!scope?.schemaIds?.length || scope.schemaIds.includes(e.schemaId));
      const events = await recentEvents(redis, orgId);
      const result = preview(condition, events.filter(inScope), maxExamples);
      return {
        matched: result.matched,
        total: result.total,
        window: events.length,
        examples: result.examples.map((e) => ({
          id: e.id,
          receivedAt: e.receivedAt,
          severity: e.severity,
          title: e.title ?? null,
          entity: e.entity ?? null,
          sourceId: e.sourceId,
          schemaId: e.schemaId,
          flat: e.flat,
        })),
      };
    },
  );
}
