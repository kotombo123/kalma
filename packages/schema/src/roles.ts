import type { FieldRole, FlatRecord, FlatValue, GuessedRoles } from '@alerting/contracts';

/**
 * Name dictionaries: key → weight. Keys are compared after `normKey` (lower case, no `_ - @ .`),
 * against both the full path (`labels.severity`) and its last segment (`severity`).
 */
const NAMES: Record<FieldRole, Record<string, number>> = {
  severity: {
    labelsseverity: 1,
    severity: 1,
    level: 0.95,
    loglevel: 0.95,
    lvl: 0.9,
    sev: 0.9,
    priority: 0.8,
    urgency: 0.7,
  },
  timestamp: {
    timestamp: 1,
    ts: 0.95,
    time: 0.9,
    startsat: 0.9,
    occurredat: 0.9,
    eventtime: 0.9,
    datetime: 0.85,
    createdat: 0.8,
    when: 0.75,
    date: 0.7,
    metats: 1,
  },
  title: {
    annotationssummary: 1,
    summary: 1,
    title: 1,
    subject: 0.9,
    alertname: 0.85,
    msg: 0.8,
    message: 0.8,
    errormessage: 0.8,
    reason: 0.6,
    description: 0.6,
    evt: 0.55,
    event: 0.55,
    type: 0.5,
    name: 0.4,
  },
  message: {
    message: 1,
    msg: 1,
    errormessage: 0.95,
    annotationsdescription: 0.95,
    description: 0.9,
    text: 0.8,
    detail: 0.7,
    details: 0.7,
    body: 0.7,
    reason: 0.6,
    summary: 0.6,
    annotationssummary: 0.6,
  },
  status: {
    status: 1,
    state: 0.9,
    phase: 0.6,
  },
  entity: {
    labelsservice: 1,
    service: 1,
    servicename: 1,
    hostname: 0.9,
    host: 0.85,
    workflowid: 0.9,
    app: 0.8,
    application: 0.8,
    component: 0.8,
    instance: 0.7,
    resource: 0.7,
    tradeid: 0.8,
    batchid: 0.8,
    account: 0.7,
    instrument: 0.6,
    producer: 0.5,
  },
  dedupKey: {
    dedupkey: 1,
    fingerprint: 1,
    incidentref: 0.9,
    incidentid: 0.9,
    alertid: 0.9,
    alertname: 0.8,
    workflowid: 0.7,
    tradeid: 0.6,
    batchid: 0.6,
  },
};

/** Ids that are unique per message, so useless as an entity or dedup key. */
const PER_MESSAGE_ID = /^(request|req|trace|span|event|message|msg|correlation)id$/;

const SEVERITY_TOKENS = new Set([
  'critical',
  'crit',
  'fatal',
  'emergency',
  'emerg',
  'alert',
  'panic',
  'error',
  'err',
  'high',
  'major',
  'p1',
  'p2',
  'warning',
  'warn',
  'medium',
  'minor',
  'p3',
  'info',
  'information',
  'notice',
  'low',
  'debug',
  'trace',
  'ok',
  'p4',
  'p5',
]);
const STATUS_TOKENS = new Set([
  'firing',
  'resolved',
  'ok',
  'open',
  'closed',
  'active',
  'recovered',
  'triggered',
  'alerting',
  'acknowledged',
  'failed',
  'success',
  'succeeded',
]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const normKey = (s: string) => s.toLowerCase().replace(/[_\-@.]/g, '');

/** How much the value itself looks like the role, 0–1. */
const VALUE_SCORE: Record<FieldRole, (v: FlatValue) => number> = {
  severity: (v) => (typeof v === 'string' && SEVERITY_TOKENS.has(v.toLowerCase()) ? 1 : 0),
  timestamp: (v) => {
    if (typeof v === 'string') return ISO_DATE.test(v) ? 1 : /^\d{10}(\d{3})?$/.test(v) ? 0.8 : 0;
    if (typeof v === 'number') return isEpochSeconds(v) || isEpochMillis(v) ? 0.9 : 0;
    return 0;
  },
  title: (v) => (typeof v === 'string' && v.length >= 3 && v.length <= 200 ? (v.includes(' ') ? 1 : 0.6) : 0),
  message: (v) => (typeof v === 'string' && v.length >= 3 ? (v.includes(' ') ? 1 : 0.4) : 0),
  status: (v) => (typeof v === 'string' && STATUS_TOKENS.has(v.toLowerCase()) ? 1 : 0),
  entity: (v) => (typeof v === 'string' && v.length > 0 && v.length <= 120 && !v.includes(' ') ? 1 : 0),
  dedupKey: (v) =>
    (typeof v === 'string' && v.length > 0 && !v.includes(' ')) || typeof v === 'number' ? 1 : 0,
};

const isEpochSeconds = (n: number) => Number.isInteger(n) && n >= 1e9 && n < 1e10;
const isEpochMillis = (n: number) => Number.isInteger(n) && n >= 1e12 && n < 1e13;

/** Roles that may be guessed from the value alone, when no name matches. */
const VALUE_ONLY: Partial<Record<FieldRole, number>> = { timestamp: 0.5, severity: 0.45, status: 0.45 };

export const MIN_CONFIDENCE = 0.3;

function nameScore(role: FieldRole, path: string): number {
  const dict = NAMES[role];
  const segments = path.replace(/\[\d+\]/g, '').split('.');
  const last = normKey(segments.at(-1) ?? '');
  const full = normKey(path.replace(/\[\d+\]/g, ''));
  if (role === 'entity' || role === 'dedupKey') {
    if (PER_MESSAGE_ID.test(last)) return 0;
    const exact = dict[full] ?? dict[last];
    if (exact !== undefined) return exact;
    return /id$/.test(last) && last.length > 2 ? 0.5 : 0;
  }
  return dict[full] ?? dict[last] ?? 0;
}

export function scoreRole(role: FieldRole, path: string, value: FlatValue): number {
  const name = nameScore(role, path);
  const val = VALUE_SCORE[role](value);
  if (name > 0) {
    // A name match whose value contradicts the role (a "time" field holding "abc") is weak.
    if (val === 0 && (role === 'timestamp' || role === 'severity' || role === 'status')) return name * 0.3;
    return 0.6 * name + 0.4 * val;
  }
  return (VALUE_ONLY[role] ?? 0) * val;
}

/**
 * Best field per role with a 0–1 confidence. Ties go to the shallower path, then to the
 * earlier field. Roles with nothing above MIN_CONFIDENCE are left out.
 */
export function guessRoles(flat: FlatRecord): GuessedRoles {
  const out: GuessedRoles = {};
  for (const role of Object.keys(NAMES) as FieldRole[]) {
    let best: { path: string; confidence: number; depth: number } | undefined;
    for (const [path, value] of Object.entries(flat)) {
      const confidence = scoreRole(role, path, value);
      if (confidence < MIN_CONFIDENCE) continue;
      const depth = path.split('.').length;
      if (!best || confidence > best.confidence || (confidence === best.confidence && depth < best.depth)) {
        best = { path, confidence, depth };
      }
    }
    if (best) out[role] = { path: best.path, confidence: Math.round(best.confidence * 100) / 100 };
  }
  return out;
}
