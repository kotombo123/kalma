import i18n from './i18n.ts';
import type { Severity } from './types.ts';
import { fieldLabel } from './labels.ts';

export type Op =
  'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'nin' | 'contains' | 'matches' | 'glob' | 'exists';
export interface Leaf {
  field: string;
  op: Op;
  value?: unknown;
}
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | Leaf;
export type Target =
  { type: 'team'; teamId: string } | { type: 'oncall'; teamId: string } | { type: 'user'; userId: string };
export type Channel = 'ui' | 'email' | 'telegram' | 'teams' | 'sms' | 'phone';

/** What the editor sends (POST/PUT /rules) — a Rule without server-owned fields. */
export interface RuleDraft {
  teamId: string;
  name: string;
  description?: string;
  enabled: boolean;
  scope?: { sourceIds?: string[]; schemaIds?: string[] };
  condition: Condition;
  presentation: {
    titleTemplate: string;
    bodyTemplate?: string;
    fields: { label: string; template: string; highlight?: 'red' | 'amber' | 'green' }[];
    severity?: Severity;
  };
  dedup: { keyTemplate?: string; windowSec: number };
  grouping?: { by: string[]; windowSec: number };
  routing: { targets: Target[]; channels?: Channel[]; escalation?: { afterMin: number; maxLevel: number } };
  runbookId?: string;
  autoResolve: { onSourceResolved: boolean; onRunbookSuccess: boolean };
}

export interface RuleRow {
  id: string;
  teamId: string;
  teamName: string;
  name: string;
  enabled: boolean;
  version: number;
  origin: 'ui' | 'api' | 'file';
  filePath: string | null;
  fileError: string | null;
  updatedAt: string;
  definition: RuleDraft & { id: string; orgId: string; version: number; origin: string };
}


/** English UI unless Polish is chosen; read at access time. */
const isEn = () => i18n.language !== 'pl';
/** A label map that answers in the current UI language (works with `MAP[key]` and Object.entries). */
function localized<K extends string>(pl: Record<K, string>, en: Record<K, string>): Record<K, string> {
  return new Proxy(pl, { get: (target, key) => (isEn() ? en : target)[key as K] });
}

const OP_LABEL_PL: Record<Op, string> = {
  eq: 'to',
  neq: 'to nie',
  gt: 'większe niż',
  gte: 'co najmniej',
  lt: 'mniejsze niż',
  lte: 'co najwyżej',
  in: 'to jedno z',
  nin: 'to żadne z',
  contains: 'zawiera',
  matches: 'pasuje do wyrażenia regularnego',
  glob: 'pasuje do wzorca',
  exists: 'jest podane',
};

const OP_LABEL_EN: Record<Op, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'greater than',
  gte: 'at least',
  lt: 'less than',
  lte: 'at most',
  in: 'is one of',
  nin: 'is none of',
  contains: 'contains',
  matches: 'matches regular expression',
  glob: 'matches pattern',
  exists: 'is present',
};
export const OP_LABEL = localized(OP_LABEL_PL, OP_LABEL_EN);

const NORMALIZED_PL: Record<string, string> = {
  $severity: 'ważność',
  $title: 'tytuł',
  $status: 'status',
  $entity: 'czego dotyczy',
  $source: 'źródło',
  $schema: 'schemat',
};

export const NORMALIZED = localized(NORMALIZED_PL, {
  $severity: 'severity',
  $title: 'title',
  $status: 'status',
  $entity: 'affects',
  $source: 'source',
  $schema: 'message type',
});

const CHANNEL_LABEL_PL: Record<Channel, string> = {
  ui: 'Konsola',
  email: 'E-mail',
  telegram: 'Telegram',
  teams: 'Teams',
  sms: 'SMS',
  phone: 'Telefon',
};
export const CHANNEL_LABEL = localized(CHANNEL_LABEL_PL, {
  ui: 'Console',
  email: 'E-mail',
  telegram: 'Telegram',
  teams: 'Teams',
  sms: 'SMS',
  phone: 'Phone',
});

export const isGroup = (c: Condition): c is { all: Condition[] } | { any: Condition[] } =>
  'all' in c || 'any' in c;
export const childrenOf = (c: { all: Condition[] } | { any: Condition[] }) => ('all' in c ? c.all : c.any);

const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

/** The condition in plain Polish, for the rule summary. */
export function describeCondition(c: Condition): string {
  if ('not' in c) return `${isEn() ? 'not' : 'nie'} (${describeCondition(c.not)})`;
  if (isGroup(c)) {
    const parts = childrenOf(c).map(describeCondition).filter(Boolean);
    if (parts.length === 0) return isEn() ? 'every event' : 'każde zdarzenie';
    return parts.join('all' in c ? (isEn() ? ' and ' : ' i ') : isEn() ? ' or ' : ' lub ');
  }
  if (!c.field) return '';
  const field = fieldLabel(c.field).toLowerCase();
  return c.op === 'exists' ? `${field} ${OP_LABEL.exists}` : `${field} ${OP_LABEL[c.op]} ${show(c.value)}`;
}

export function emptyDraft(teamId = ''): RuleDraft {
  return {
    teamId,
    name: '',
    enabled: true,
    condition: { all: [{ field: '$severity', op: 'in', value: ['critical', 'error'] }] },
    presentation: { titleTemplate: '{{title}}', fields: [] },
    dedup: { windowSec: 600 },
    routing: { targets: teamId ? [{ type: 'team', teamId }] : [] },
    autoResolve: { onSourceResolved: true, onRunbookSuccess: false },
  };
}
