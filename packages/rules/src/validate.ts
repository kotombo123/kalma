import {
  err,
  EventStatus,
  ok,
  Rule,
  Severity,
  type Condition,
  type Result,
  type RuleInput,
  type SchemaField,
} from '@alerting/contracts';
import { validateTemplate } from '@alerting/templates';
import { NORMALIZED_FIELDS } from './compile.ts';

export interface RuleIssue {
  /** Where in the rule, e.g. `condition.all[1].value`. */
  path: string;
  message: string;
}

const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte']);
const EQUALITY_OPS = new Set(['eq', 'neq', 'in', 'nin']);
/** Normalized fields with a closed set of values. */
const ENUM_FIELDS: Record<string, readonly string[]> = {
  $severity: Severity.options,
  $status: EventStatus.options,
};
const STRING_TYPES = new Set(['string']);

/**
 * Checks a condition tree. With `knownFields` (fields of the org's known schemas), also checks
 * that each `flat` path exists and that numeric operators are not used on text-only fields.
 */
export function validateCondition(
  condition: Condition,
  knownFields?: SchemaField[],
  at = 'condition',
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const types = knownFields && fieldTypes(knownFields);

  const walk = (c: Condition, path: string) => {
    if ('all' in c) return c.all.forEach((x, i) => walk(x, `${path}.all[${i}]`));
    if ('any' in c) return c.any.forEach((x, i) => walk(x, `${path}.any[${i}]`));
    if ('not' in c) return walk(c.not, `${path}.not`);

    const { field, op, value } = c;
    const issue = (message: string, where = 'value') => issues.push({ path: `${path}.${where}`, message });

    if (field.startsWith('$')) {
      if (!(field in NORMALIZED_FIELDS)) {
        issue(`unknown field "${field}"; use one of ${Object.keys(NORMALIZED_FIELDS).join(', ')}`, 'field');
      }
      // A value outside the enum would silently never match.
      const allowed = ENUM_FIELDS[field];
      if (allowed && EQUALITY_OPS.has(op)) {
        const bad = (Array.isArray(value) ? value : [value]).filter((v) => !allowed.includes(String(v)));
        if (bad.length)
          issue(
            `${field} is one of ${allowed.join(', ')}; got ${bad.map((v) => JSON.stringify(v)).join(', ')}`,
          );
      }
    } else if (types) {
      const t = types.get(field.replace(/\[\d+\]/g, '[]'));
      if (!t) issue(`field "${field}" is not in any known schema`, 'field');
      else if (NUMERIC_OPS.has(op) && [...t].every((x) => STRING_TYPES.has(x))) {
        issue(`"${op}" needs a number, but "${field}" is ${[...t].join(' | ')}`, 'op');
      }
    }

    switch (op) {
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const isSeverity = field === '$severity' && Severity.safeParse(value).success;
        const isNumber =
          typeof value === 'number' ||
          (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
        if (!isSeverity && !isNumber)
          issue(`"${op}" needs a number${field === '$severity' ? ' or a severity' : ''}`);
        break;
      }
      case 'in':
      case 'nin':
        if (!Array.isArray(value) || value.length === 0) issue(`"${op}" needs a non-empty list`);
        break;
      case 'matches':
        if (typeof value !== 'string') issue('"matches" needs a regular expression string');
        else {
          try {
            new RegExp(value);
          } catch (e) {
            issue(`invalid regular expression: ${(e as Error).message}`);
          }
        }
        break;
      case 'glob':
      case 'contains':
        if (typeof value !== 'string' || value === '') issue(`"${op}" needs a non-empty string`);
        break;
      case 'exists':
        if (value !== undefined && typeof value !== 'boolean')
          issue('"exists" takes true, false or no value');
        break;
      case 'eq':
      case 'neq':
        if (value === undefined || (typeof value === 'object' && value !== null))
          issue(`"${op}" needs a single value`);
        break;
    }
  };

  walk(condition, at);
  return issues;
}

function fieldTypes(fields: SchemaField[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of fields) {
    const path = f.path.replace(/\[\d+\]/g, '[]');
    const set = out.get(path) ?? new Set<string>();
    set.add(f.type);
    out.set(path, set);
  }
  return out;
}

/** Full rule: contract shape (Zod), condition, and every template (title, body, fields, dedup key). */
export function validateRule(
  input: RuleInput | unknown,
  knownFields?: SchemaField[],
): Result<Rule, RuleIssue[]> {
  const parsed = Rule.safeParse(input);
  if (!parsed.success) {
    return err(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  const rule = parsed.data;
  const issues = validateCondition(rule.condition, knownFields);

  const templates: [string, string | undefined][] = [
    ['presentation.titleTemplate', rule.presentation.titleTemplate],
    ['presentation.bodyTemplate', rule.presentation.bodyTemplate],
    ['dedup.keyTemplate', rule.dedup.keyTemplate],
    ...rule.presentation.fields.map((f, i): [string, string] => [
      `presentation.fields[${i}].template`,
      f.template,
    ]),
  ];
  for (const [path, template] of templates) {
    if (template === undefined) continue;
    const r = validateTemplate(template);
    if (!r.ok) issues.push({ path, message: r.error });
  }

  return issues.length ? err(issues) : ok(rule);
}
