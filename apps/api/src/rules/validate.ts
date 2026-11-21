/**
 * Rule checks that need the org's data (OWASP A01: every referenced id must belong to the caller's org)
 * plus operator/value checks. Field-level semantics will move to @alerting/rules (B1-07).
 */
import { type Condition, type Rule, type SchemaField } from '@alerting/contracts';
import { validateCondition } from '@alerting/rules';
import { and, eq, inArray, t, type Db } from '@alerting/db';
import { validateTemplate } from '@alerting/templates';

export interface Issue {
  path: (string | number)[];
  message: string;
}

/** `condition.all[1].value` → `['condition', 'all', 1, 'value']` (API issues use path arrays). */
export function toPath(p: string): (string | number)[] {
  return p
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
}

/**
 * Operator / value checks come from @alerting/rules (B1-07). Fields missing from the org's schemas
 * are only warnings here: events often have optional fields the sample did not show.
 */
export function checkCondition(condition: Condition, fields: SchemaField[]) {
  const all = validateCondition(condition, fields.length ? fields : undefined).map((i) => ({
    path: toPath(i.path),
    message: i.message,
  }));
  const isUnknownField = (i: Issue) =>
    i.path.at(-1) === 'field' && i.message.includes('not in any known schema');
  return { issues: all.filter((i) => !isUnknownField(i)), warnings: all.filter(isUnknownField) };
}

/** Every field seen in the org's schemas (field picker, "unknown field" warnings, type checks). */
export async function knownFields(db: Db, orgId: string): Promise<SchemaField[]> {
  const rows = await db
    .select({ fields: t.schemas.fields })
    .from(t.schemas)
    .where(eq(t.schemas.orgId, orgId));
  return rows.flatMap((r) => r.fields);
}

async function idsIn<T extends { id: unknown }>(rows: Promise<T[]>) {
  return new Set((await rows).map((r) => r.id as string));
}

/** Every id the rule references must exist in the org. */
export async function checkReferences(
  db: Db,
  orgId: string,
  rule: Pick<Rule, 'teamId' | 'runbookId' | 'routing' | 'scope'>,
) {
  const issues: Issue[] = [];
  const teamIds = [rule.teamId, ...rule.routing.targets.flatMap((x) => ('teamId' in x ? [x.teamId] : []))];
  const userIds = rule.routing.targets.flatMap((x) => ('userId' in x ? [x.userId] : []));
  const sourceIds = rule.scope?.sourceIds ?? [];
  const schemaIds = rule.scope?.schemaIds ?? [];

  const [teams, users, runbooks, sources, schemas] = await Promise.all([
    idsIn(
      db
        .select({ id: t.teams.id })
        .from(t.teams)
        .where(and(eq(t.teams.orgId, orgId), inArray(t.teams.id, teamIds))),
    ),
    userIds.length
      ? idsIn(
          db
            .select({ id: t.memberships.userId })
            .from(t.memberships)
            .where(and(eq(t.memberships.orgId, orgId), inArray(t.memberships.userId, userIds))),
        )
      : new Set<string>(),
    rule.runbookId
      ? idsIn(
          db
            .select({ id: t.runbooks.id })
            .from(t.runbooks)
            .where(and(eq(t.runbooks.orgId, orgId), eq(t.runbooks.id, rule.runbookId))),
        )
      : new Set<string>(),
    sourceIds.length
      ? idsIn(
          db
            .select({ id: t.sources.id })
            .from(t.sources)
            .where(and(eq(t.sources.orgId, orgId), inArray(t.sources.id, sourceIds))),
        )
      : new Set<string>(),
    schemaIds.length
      ? idsIn(
          db
            .select({ id: t.schemas.id })
            .from(t.schemas)
            .where(and(eq(t.schemas.orgId, orgId), inArray(t.schemas.id, schemaIds))),
        )
      : new Set<string>(),
  ]);

  if (!teams.has(rule.teamId)) issues.push({ path: ['teamId'], message: 'Team not found' });
  rule.routing.targets.forEach((x, i) => {
    if ('teamId' in x && !teams.has(x.teamId))
      issues.push({ path: ['routing', 'targets', i, 'teamId'], message: 'Team not found' });
    if ('userId' in x && !users.has(x.userId))
      issues.push({ path: ['routing', 'targets', i, 'userId'], message: 'User not found' });
  });
  if (rule.runbookId && !runbooks.has(rule.runbookId))
    issues.push({ path: ['runbookId'], message: 'Runbook not found' });
  sourceIds.forEach((id, i) => {
    if (!sources.has(id)) issues.push({ path: ['scope', 'sourceIds', i], message: 'Source not found' });
  });
  schemaIds.forEach((id, i) => {
    if (!schemas.has(id)) issues.push({ path: ['scope', 'schemaIds', i], message: 'Schema not found' });
  });
  return issues;
}

/** Every template in the rule must compile (B1-06 mini-Mustache). */
export function checkTemplates(rule: Pick<Rule, 'presentation' | 'dedup'>): Issue[] {
  const templates: [(string | number)[], string | undefined][] = [
    [['presentation', 'titleTemplate'], rule.presentation.titleTemplate],
    [['presentation', 'bodyTemplate'], rule.presentation.bodyTemplate],
    [['dedup', 'keyTemplate'], rule.dedup.keyTemplate],
    ...rule.presentation.fields.map((f, i): [(string | number)[], string] => [
      ['presentation', 'fields', i, 'template'],
      f.template,
    ]),
  ];
  return templates.flatMap(([path, tpl]) => {
    if (tpl === undefined) return [];
    const r = validateTemplate(tpl);
    return r.ok ? [] : [{ path, message: `Template error: ${r.error}` }];
  });
}
