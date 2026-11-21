import { createHash } from 'node:crypto';
import type {
  Envelope,
  FieldRole,
  FlatRecord,
  FlatValue,
  Mapping,
  NormalizedEvent,
  RoleBinding,
  Severity,
} from '@alerting/contracts';
import { render as renderTemplate } from '@alerting/templates';
import { guessRoles } from './roles.ts';

/** Lower-case value → severity. `Mapping.severityMap` is checked first. */
export const DEFAULT_SEVERITY_MAP: Record<string, Severity> = {
  critical: 'critical',
  crit: 'critical',
  fatal: 'critical',
  emergency: 'critical',
  emerg: 'critical',
  alert: 'critical',
  panic: 'critical',
  p1: 'critical',
  error: 'error',
  err: 'error',
  high: 'error',
  major: 'error',
  p2: 'error',
  warning: 'warning',
  warn: 'warning',
  medium: 'warning',
  minor: 'warning',
  p3: 'warning',
  info: 'info',
  information: 'info',
  notice: 'info',
  low: 'info',
  debug: 'info',
  trace: 'info',
  ok: 'info',
  p4: 'info',
  p5: 'info',
};
/** Syslog numeric levels 0–7. */
const SYSLOG: Severity[] = ['critical', 'critical', 'critical', 'error', 'warning', 'info', 'info', 'info'];
export const DEFAULT_SEVERITY: Severity = 'info';

export const DEFAULT_RESOLVED_VALUES = ['resolved', 'ok', 'recovered', 'closed'];

export interface NormalizeInput {
  envelope: Pick<Envelope, 'id' | 'orgId' | 'sourceId' | 'ingestTs' | 'receivedAt' | 'raw'>;
  schemaId: string;
  /** Computed on the flat record before `normalizeFlat` (types change there). */
  fingerprint: string;
  flat: FlatRecord;
  /** No mapping yet (a `new` schema): roles come from `guessRoles`. */
  mapping?: Pick<Mapping, 'roles' | 'severityMap' | 'resolvedValues'>;
  /** Renders `RoleBinding.template`; defaults to `@alerting/templates`. */
  render?: (template: string, flat: FlatRecord) => string;
}

export function normalize(input: NormalizeInput): NormalizedEvent {
  const { envelope, mapping, fingerprint } = input;
  const flat = normalizeFlat(input.flat);
  const render = input.render ?? renderTemplate;

  const roles: Partial<Record<FieldRole, RoleBinding>> =
    mapping?.roles ??
    Object.fromEntries(Object.entries(guessRoles(input.flat)).map(([role, g]) => [role, { path: g.path }]));

  const value = (role: FieldRole): FlatValue | undefined => {
    const binding = roles[role];
    if (binding?.path !== undefined) return flat[binding.path];
    if (binding?.template !== undefined) return render(binding.template, flat);
    return undefined; // `expr` is reserved, not evaluated yet
  };
  const text = (role: FieldRole) => {
    const v = value(role);
    return v === undefined || v === null || v === '' ? undefined : String(v);
  };

  const title = text('title');
  const entity = text('entity');

  return {
    id: envelope.id,
    orgId: envelope.orgId,
    sourceId: envelope.sourceId,
    ingestTs: envelope.ingestTs,
    receivedAt: envelope.receivedAt,
    schemaId: input.schemaId,
    fingerprint,
    severity: normalizeSeverity(value('severity'), mapping?.severityMap),
    timestamp: normalizeTimestamp(value('timestamp')) ?? envelope.receivedAt,
    title,
    message: text('message'),
    dedupKey: text('dedupKey') ?? defaultDedupKey(fingerprint, entity, title),
    status: normalizeStatus(value('status'), mapping?.resolvedValues),
    entity,
    raw: envelope.raw,
    flat,
  };
}

export function normalizeSeverity(value: FlatValue | undefined, map?: Record<string, Severity>): Severity {
  if (value === undefined || value === null) return DEFAULT_SEVERITY;
  const key = String(value).trim();
  const custom = map?.[key] ?? map?.[key.toLowerCase()];
  if (custom) return custom;
  const known = DEFAULT_SEVERITY_MAP[key.toLowerCase()];
  if (known) return known;
  const n = Number(key);
  if (Number.isInteger(n) && n >= 0 && n < SYSLOG.length) return SYSLOG[n]!;
  return DEFAULT_SEVERITY;
}

// ISO-8601 date, or a date string with a 4-digit year and a clock time (RFC 2822, syslog with year).
const DATE_STRING = /^\d{4}-\d{2}-\d{2}|\b\d{4}\b.*\b\d{2}:\d{2}/;

/** ISO string, epoch seconds or epoch ms (number or numeric string) → ISO UTC; else undefined. */
export function normalizeTimestamp(value: FlatValue | undefined): string | undefined {
  if (value === undefined || value === null || typeof value === 'boolean') return undefined;
  let date: Date;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    if (n < 1e9 || n >= 1e13) return undefined; // neither epoch s nor epoch ms
    date = new Date(n < 1e10 ? n * 1000 : n);
  } else {
    if (!DATE_STRING.test(value)) return undefined;
    date = new Date(value);
  }
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function normalizeStatus(
  value: FlatValue | undefined,
  resolvedValues?: string[],
): 'firing' | 'resolved' {
  if (value === undefined || value === null) return 'firing';
  const resolved = (resolvedValues ?? DEFAULT_RESOLVED_VALUES).map((v) => v.toLowerCase());
  return resolved.includes(String(value).trim().toLowerCase()) ? 'resolved' : 'firing';
}

export function defaultDedupKey(fingerprint: string, entity?: string, title?: string): string {
  return createHash('sha1')
    .update(`${fingerprint}\n${entity ?? ''}\n${title ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

// Plain decimals only: no leading zeros ("007"), no exponents, at most 15 digits (safe as a double).
const NUMERIC = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

/** Numeric strings (CSV, XML, logfmt) become numbers so rules like `notional > 10000000` work. */
export function normalizeFlat(flat: FlatRecord): FlatRecord {
  const out: FlatRecord = {};
  for (const [path, v] of Object.entries(flat))
    out[path] = typeof v === 'string' && NUMERIC.test(v) ? Number(v) : v;
  return out;
}
