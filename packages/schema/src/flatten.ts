import type { FlatRecord, FlatValue } from '@alerting/contracts';

export interface FlattenOptions {
  /** Objects / arrays nested deeper than this are stored as a JSON string. */
  maxDepth?: number;
  /** Fields beyond this many are dropped. */
  maxFields?: number;
}

export const MAX_DEPTH = 8;
export const MAX_FIELDS = 500;

/**
 * `{ error: { code: 'X' }, labels: ['a'] }` → `{ 'error.code': 'X', 'labels[0]': 'a' }`.
 * Empty objects and arrays produce no fields. A non-object root is stored under `value`.
 */
export function flatten(raw: unknown, opts: FlattenOptions = {}): FlatRecord {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const maxFields = opts.maxFields ?? MAX_FIELDS;
  const out: FlatRecord = {};
  let count = 0;

  const put = (path: string, value: FlatValue) => {
    if (count >= maxFields) return;
    out[path] = value;
    count++;
  };

  const walk = (value: unknown, path: string, depth: number): void => {
    if (count >= maxFields) return;

    if (Array.isArray(value) || isPlainObject(value)) {
      if (depth >= maxDepth) return put(path, JSON.stringify(value));
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      } else {
        for (const [key, item] of Object.entries(value)) {
          walk(item, path ? `${path}.${key}` : key, depth + 1);
        }
      }
      return;
    }

    const leaf = toFlatValue(value);
    if (leaf !== undefined) put(path || 'value', leaf);
  };

  walk(raw, '', 0);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function toFlatValue(value: unknown): FlatValue | undefined {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'bigint':
      return value.toString();
    case 'object':
      if (value === null) return null;
      if (value instanceof Date) return value.toISOString();
      return String(value);
    default:
      return undefined; // undefined, function, symbol
  }
}
