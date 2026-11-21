import { createHash } from 'node:crypto';
import type { FlatRecord, FlatValue, SchemaField } from '@alerting/contracts';

/** `alerts[3].labels[0]` → `alerts[].labels[]`, so batches of any length share one schema. */
export const normalizePath = (path: string): string => path.replace(/\[\d+\]/g, '[]');

export const valueType = (value: FlatValue): string => (value === null ? 'null' : typeof value);

/**
 * sha1 of the sorted, de-duplicated `path:type` pairs. Independent of key order, values and
 * array lengths; any added, removed or retyped field gives a new fingerprint.
 */
export function fingerprint(flat: FlatRecord): string {
  const pairs = new Set<string>();
  for (const [path, value] of Object.entries(flat)) pairs.add(`${normalizePath(path)}:${valueType(value)}`);
  return createHash('sha1')
    .update([...pairs].sort().join('\n'))
    .digest('hex');
}

/** One entry per fingerprint pair, sorted by path, with the first value seen as the example. */
export function describeFields(flat: FlatRecord): SchemaField[] {
  const fields = new Map<string, SchemaField>();
  for (const [path, value] of Object.entries(flat)) {
    const field = { path: normalizePath(path), type: valueType(value), example: value };
    const key = `${field.path}:${field.type}`;
    if (!fields.has(key)) fields.set(key, field);
  }
  return [...fields.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
