import {
  SEVERITY_ORDER,
  type Condition,
  type FlatValue,
  type NormalizedEvent,
  type Op,
} from '@alerting/contracts';

/** What a rule looks at: the normalized event (the worker passes NormalizedEvent as is). */
export type RuleTarget = Pick<
  NormalizedEvent,
  'flat' | 'severity' | 'sourceId' | 'schemaId' | 'status' | 'entity' | 'title'
>;
export type Predicate = (event: RuleTarget) => boolean;

type Value = FlatValue | undefined;

/** Normalized fields a condition can use instead of a `flat` path. */
export const NORMALIZED_FIELDS: Record<string, (e: RuleTarget) => Value> = {
  $severity: (e) => e.severity,
  $source: (e) => e.sourceId,
  $schema: (e) => e.schemaId,
  $status: (e) => e.status,
  $entity: (e) => e.entity,
  $title: (e) => e.title,
};

export function accessor(field: string): (e: RuleTarget) => Value {
  return NORMALIZED_FIELDS[field] ?? ((e) => e.flat[field]);
}

const missing = (v: Value): v is undefined | null => v === undefined || v === null;

/** Numbers as is, numeric strings parsed, severities ranked (so `$severity gte warning` works). */
function toComparable(v: unknown, severity: boolean): number | undefined {
  if (severity && typeof v === 'string' && v in SEVERITY_ORDER)
    return SEVERITY_ORDER[v as keyof typeof SEVERITY_ORDER];
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`);
}

const regexCache = new Map<string, RegExp>();
function cachedRegExp(source: string): RegExp {
  let re = regexCache.get(source);
  if (!re) {
    re = new RegExp(source);
    regexCache.set(source, re);
  }
  return re;
}

/**
 * Builds one comparison. Semantics for a missing field (undefined / null): every operator is
 * false except `neq`, `nin` and `exists: false`, which are true.
 */
function leaf(field: string, op: Op, value: unknown): Predicate {
  const get = accessor(field);
  const severity = field === '$severity';

  switch (op) {
    case 'eq':
    case 'neq': {
      const want = String(value);
      const eq: Predicate = (e) => {
        const v = get(e);
        return !missing(v) && (v === value || String(v) === want);
      };
      return op === 'eq' ? eq : (e) => !eq(e);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const bound = toComparable(value, severity);
      if (bound === undefined) return () => false;
      const cmp =
        op === 'gt'
          ? (n: number) => n > bound
          : op === 'gte'
            ? (n: number) => n >= bound
            : op === 'lt'
              ? (n: number) => n < bound
              : (n: number) => n <= bound;
      return (e) => {
        const n = toComparable(get(e), severity);
        return n !== undefined && cmp(n);
      };
    }
    case 'in':
    case 'nin': {
      const set = new Set((Array.isArray(value) ? value : [value]).map(String));
      const has: Predicate = (e) => {
        const v = get(e);
        return !missing(v) && set.has(String(v));
      };
      return op === 'in' ? has : (e) => !has(e);
    }
    case 'contains': {
      const needle = String(value).toLowerCase();
      return (e) => {
        const v = get(e);
        return !missing(v) && String(v).toLowerCase().includes(needle);
      };
    }
    case 'matches': {
      const re = cachedRegExp(String(value));
      return (e) => {
        const v = get(e);
        return !missing(v) && re.test(String(v));
      };
    }
    case 'glob': {
      const re = globToRegExp(String(value));
      return (e) => {
        const v = get(e);
        return !missing(v) && re.test(String(v));
      };
    }
    case 'exists': {
      const want = value !== false;
      return (e) => !missing(get(e)) === want;
    }
  }
}

/** Condition tree → closure tree. No `eval`; regexes and sets are built once here. */
export function compileCondition(condition: Condition): Predicate {
  if ('all' in condition) {
    const parts = condition.all.map(compileCondition);
    if (parts.length === 1) return parts[0]!;
    return (e) => {
      for (const p of parts) if (!p(e)) return false;
      return true;
    };
  }
  if ('any' in condition) {
    const parts = condition.any.map(compileCondition);
    if (parts.length === 1) return parts[0]!;
    return (e) => {
      for (const p of parts) if (p(e)) return true;
      return false;
    };
  }
  if ('not' in condition) {
    const inner = compileCondition(condition.not);
    return (e) => !inner(e);
  }
  return leaf(condition.field, condition.op, condition.value);
}
