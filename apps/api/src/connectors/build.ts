/**
 * Connector files → collector (Vector) config. Pure functions: no files, no database.
 * See docs/connectors/implementation_plan.md §2–4.
 */
import type { ConnectorTemplate } from '@alerting/contracts';

export type Components = Record<string, Record<string, unknown>>;
export interface CollectorPart {
  sources: Components;
  transforms?: Components;
}
export type Built =
  { ok: true; config: Record<string, unknown>; ports: number[] } | { ok: false; error: string };

/** Never allowed, whatever COLLECTOR_ALLOWED_SOURCES says: they run commands or read the collector's disk. */
const FORBIDDEN_SOURCES = new Set(['exec', 'file']);
const FORBIDDEN_TRANSFORMS = new Set(['lua']);

/** "5514-5530,6000" → predicate */
export function portRange(spec: string): (port: number) => boolean {
  const parts = spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [a, b] = p.split('-').map(Number);
      return [a!, b ?? a!] as const;
    });
  return (port) => parts.some(([a, b]) => port >= a && port <= b);
}

/** Template settings + the connector's values → typed values, or what is wrong. */
export function resolveSettings(
  tpl: ConnectorTemplate,
  given: Record<string, unknown> = {},
  portOk: (p: number) => boolean,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const values: Record<string, unknown> = {};
  for (const key of Object.keys(given))
    if (!(key in tpl.settings))
      return { ok: false, error: `settings.${key}: szablon nie ma takiego ustawienia` };
  for (const [key, s] of Object.entries(tpl.settings)) {
    const v = given[key] ?? s.default;
    if (v === undefined || v === '') {
      if (s.required !== false && s.default === undefined)
        return { ok: false, error: `settings.${key}: wymagane (${s.label})` };
      continue;
    }
    if (s.type === 'port' || s.type === 'number') {
      const n = Number(v);
      if (!Number.isInteger(n)) return { ok: false, error: `settings.${key}: musi być liczbą całkowitą` };
      if (s.type === 'port' && !portOk(n))
        return { ok: false, error: `settings.${key}: port ${n} jest poza dozwolonym zakresem` };
      values[key] = n;
    } else if (s.type === 'enum') {
      if (!s.values?.includes(String(v)))
        return { ok: false, error: `settings.${key}: jedna z wartości: ${s.values?.join(', ')}` };
      values[key] = String(v);
    } else values[key] = String(v);
  }
  return { ok: true, values };
}

/**
 * Fill `{{name}}` placeholders inside a parsed template. A value that is exactly "{{port}}" keeps its
 * type (number); placeholders inside longer strings are replaced as text. Works on values, never on
 * the config's structure, so a setting cannot add components.
 */
export function fill(node: unknown, values: Record<string, unknown>): unknown {
  if (typeof node === 'string') {
    const whole = /^\{\{\s*(\w+)\s*\}\}$/.exec(node);
    if (whole) return values[whole[1]!] ?? '';
    return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => String(values[k] ?? ''));
  }
  if (Array.isArray(node)) return node.map((x) => fill(x, values));
  if (node && typeof node === 'object')
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, values)]));
  return node;
}

/** Ports a source listens on: `address: "0.0.0.0:5514"` or `port: 5514`. */
export function portsOf(source: Record<string, unknown>): number[] {
  const out: number[] = [];
  if (typeof source.address === 'string') {
    const m = /:(\d+)$/.exec(source.address);
    if (m) out.push(Number(m[1]));
  }
  if (typeof source.port === 'number') out.push(source.port);
  return out;
}

/**
 * The person's collector part + Kalma's delivery = one Vector config file. Component ids get the
 * connector's prefix so files never clash; the http sink reads every component nobody else consumes.
 */
export function buildCollector(
  part: CollectorPart,
  o: {
    connector: string;
    allowedSources: Set<string>;
    portOk: (p: number) => boolean;
    ingestUrl: string;
    sourceId: string;
    apiKey: string;
  },
): Built {
  const sources = Object.entries(part.sources ?? {});
  const transforms = Object.entries(part.transforms ?? {});
  if (sources.length === 0) return { ok: false, error: 'collector.sources: dodaj przynajmniej jedno źródło' };

  const ports: number[] = [];
  for (const [id, s] of sources) {
    const type = String(s.type ?? '');
    if (!type) return { ok: false, error: `collector.sources.${id}: brak pola type` };
    if (FORBIDDEN_SOURCES.has(type) || !o.allowedSources.has(type))
      return { ok: false, error: `collector.sources.${id}: typ źródła "${type}" jest niedozwolony` };
    for (const p of portsOf(s)) {
      if (!o.portOk(p))
        return { ok: false, error: `collector.sources.${id}: port ${p} jest poza dozwolonym zakresem` };
      ports.push(p);
    }
  }
  for (const [id, tr] of transforms) {
    const type = String(tr.type ?? '');
    if (!type) return { ok: false, error: `collector.transforms.${id}: brak pola type` };
    if (FORBIDDEN_TRANSFORMS.has(type))
      return {
        ok: false,
        error: `collector.transforms.${id}: typ transformacji "${type}" jest niedozwolony`,
      };
  }

  const known = new Set([...sources, ...transforms].map(([id]) => id));
  const rename = (id: string) => `${o.connector}__${id}`;
  const consumed = new Set<string>();
  const outTransforms: Components = {};
  for (const [id, tr] of transforms) {
    const inputs = Array.isArray(tr.inputs) ? tr.inputs.map(String) : [];
    for (const i of inputs) {
      if (!known.has(i))
        return { ok: false, error: `collector.transforms.${id}.inputs: nieznany komponent "${i}"` };
      consumed.add(i);
    }
    outTransforms[rename(id)] = { ...tr, inputs: inputs.map(rename) };
  }
  const leaves = [...known].filter((id) => !consumed.has(id)).map(rename);

  return {
    ok: true,
    ports,
    config: {
      sources: Object.fromEntries(sources.map(([id, s]) => [rename(id), s])),
      ...(transforms.length && { transforms: outTransforms }),
      sinks: {
        [`${o.connector}__kalma`]: {
          type: 'http',
          inputs: leaves,
          uri: `${o.ingestUrl.replace(/\/$/, '')}/ingest/${o.sourceId}`,
          method: 'post',
          encoding: { codec: 'json' },
          framing: { method: 'newline_delimited' },
          request: { headers: { 'x-api-key': o.apiKey } },
        },
      },
    },
  };
}
