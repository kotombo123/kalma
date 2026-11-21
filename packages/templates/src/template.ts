import { err, ok, type Result } from '@alerting/contracts';
import { FILTERS } from './filters.ts';

/**
 * Mini-Mustache. Syntax:
 * - `{{path}}` — value at `path` (`a.b`, `items[0].id`, or a flat key like `error.code`);
 * - `{{path | filter:arg1,arg2 | filter2}}` — filters from FILTERS, args bare or quoted;
 * - `{{#if path}}…{{else}}…{{/if}}` — sections, nestable; falsy = missing, null, false, '', 0, [].
 * Only lookups and the fixed filter set run: templates can never execute code.
 */
export interface RenderOptions {
  /** Escape `& < > " '` in substituted values (literal template text is left as written). */
  html?: boolean;
}

export type TemplateData = Record<string, unknown>;

type Expr = { path: string; filters: { name: string; args: string[] }[] };
type Node = string | { expr: Expr } | { if: string; then: Node[]; else: Node[] };

export interface CompiledTemplate {
  render(data: TemplateData, opts?: RenderOptions): string;
  /** Paths the template reads, in order of first use (for "missing value" checks and validation). */
  variables: string[];
}

export class TemplateError extends Error {
  override name = 'TemplateError';
}

const TAG = /\{\{\s*([\s\S]*?)\s*\}\}/g;
const PATH = /^[\w$@-]+(?:\.[\w$@-]+|\[\d+\])*$/;

function parseExpr(source: string): Expr {
  const [pathPart = '', ...filterParts] = splitOutsideQuotes(source, '|');
  const path = pathPart.trim();
  if (!PATH.test(path)) throw new TemplateError(`invalid path "${path}" in {{${source}}}`);
  const filters = filterParts.map((part) => {
    const trimmed = part.trim();
    const colon = trimmed.indexOf(':');
    const name = colon === -1 ? trimmed : trimmed.slice(0, colon).trim();
    if (!(name in FILTERS)) throw new TemplateError(`unknown filter "${name}" in {{${source}}}`);
    const args = colon === -1 ? [] : splitOutsideQuotes(trimmed.slice(colon + 1), ',').map(unquote);
    return { name, args };
  });
  return { path, filters };
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let quote: string | undefined;
  let current = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === sep) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) throw new TemplateError(`unterminated quote in "${s}"`);
  out.push(current);
  return out;
}

function unquote(arg: string): string {
  const t = arg.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))
    ? t.slice(1, -1)
    : t;
}

function parse(template: string): { nodes: Node[]; variables: string[] } {
  const variables = new Set<string>();
  const root: Node[] = [];
  // Open sections: where nodes go now, plus the section itself.
  const stack: { target: Node[]; section?: Extract<Node, { if: string }> }[] = [{ target: root }];
  const top = () => stack.at(-1)!;
  let last = 0;

  for (const m of template.matchAll(TAG)) {
    if (m.index > last) top().target.push(template.slice(last, m.index));
    last = m.index + m[0].length;
    const body = m[1]!;

    if (body.startsWith('#if ')) {
      const path = body.slice(4).trim();
      if (!PATH.test(path)) throw new TemplateError(`invalid path "${path}" in {{${body}}}`);
      variables.add(path);
      const section = { if: path, then: [] as Node[], else: [] as Node[] };
      top().target.push(section);
      stack.push({ target: section.then, section });
    } else if (body === 'else') {
      const s = top().section;
      if (!s || top().target !== s.then) throw new TemplateError('{{else}} outside {{#if}}');
      top().target = s.else;
    } else if (body === '/if') {
      if (!top().section) throw new TemplateError('{{/if}} without {{#if}}');
      stack.pop();
    } else {
      const expr = parseExpr(body);
      variables.add(expr.path);
      top().target.push({ expr });
    }
  }
  if (stack.length > 1) throw new TemplateError(`unclosed {{#if ${top().section!.if}}}`);
  if (last < template.length) root.push(template.slice(last));
  return { nodes: root, variables: [...variables] };
}

/** Flat key first (`error.code` in a FlatRecord), then a walk through nested objects / arrays. */
export function lookup(data: TemplateData, path: string): unknown {
  if (Object.hasOwn(data, path)) return data[path];
  let current: unknown = data;
  for (const key of path.split(/\.|\[(\d+)\]/).filter((k) => k !== undefined && k !== '')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current;
}

const truthy = (v: unknown) =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === '' ||
    v === 0 ||
    (Array.isArray(v) && v.length === 0)
  );

const toText = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

function run(nodes: Node[], data: TemplateData, html: boolean): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node === 'string') out += node;
    else if ('expr' in node) {
      let value = lookup(data, node.expr.path);
      for (const f of node.expr.filters) value = FILTERS[f.name]!(value, f.args);
      const text = toText(value);
      out += html ? escapeHtml(text) : text;
    } else out += run(truthy(lookup(data, node.if)) ? node.then : node.else, data, html);
  }
  return out;
}

const CACHE_LIMIT = 1000;
const cache = new Map<string, CompiledTemplate>();

/** Parses once and caches by source. Throws TemplateError on bad syntax, unknown filters or paths. */
export function compile(template: string): CompiledTemplate {
  const hit = cache.get(template);
  if (hit) return hit;
  const { nodes, variables } = parse(template);
  const compiled: CompiledTemplate = {
    render: (data, opts) => run(nodes, data, opts?.html ?? false),
    variables,
  };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(template, compiled);
  return compiled;
}

/** For API / UI validation of rule presentation and runbook text. */
export function validateTemplate(template: string): Result<{ variables: string[] }> {
  try {
    return ok({ variables: compile(template).variables });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Renders and never throws: a template that does not compile comes back unchanged, so a bad
 * template in a rule degrades a title instead of crashing the worker or notifier.
 */
export function render(template: string, data: TemplateData, opts?: RenderOptions): string {
  let compiled: CompiledTemplate;
  try {
    compiled = compile(template);
  } catch {
    return template;
  }
  return compiled.render(data, opts);
}
