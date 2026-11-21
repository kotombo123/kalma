/** Structural diff of two JSON values: one entry per changed leaf path (for rule version history). */
export interface Change {
  path: string;
  before?: unknown;
  after?: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function diff(before: unknown, after: unknown, path = ''): Change[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: Change[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      out.push(...diff(before[i], after[i], `${path}[${i}]`));
    }
    return out;
  }
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diff(before[k], after[k], path ? `${path}.${k}` : k));
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [
    {
      path: path || '(root)',
      ...(before !== undefined && { before }),
      ...(after !== undefined && { after }),
    },
  ];
}
