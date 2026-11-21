/** Graph screen (F-20): how the API's numbers become columns, marks and labels. */
import type { GraphNode, GraphNodeKind } from '@alerting/contracts';
import i18n from '../../lib/i18n.ts';
import { uiLocale } from '../../lib/format.ts';

/** `title` and `hint` are i18n keys, translated at render. */
export const COLUMNS: { kind: GraphNodeKind; title: string; hint: string }[] = (
  ['source', 'rule', 'team', 'user'] as const
).map((kind) => ({ kind, title: `graph.columns.${kind}.title`, hint: `graph.columns.${kind}.hint` }));

/** i18n keys, translated at render. */
export const KIND_NAME: Record<GraphNodeKind, string> = {
  source: 'graph.kind.source',
  rule: 'graph.kind.rule',
  team: 'graph.kind.team',
  user: 'graph.kind.user',
};

/**
 * The ledger margin mark of a system (noise) or a person (load), both measured against an average:
 * ≥ 1.5× is red ink, ≥ 1.2× ochre pencil; a person far below the team average gets blue ink.
 */
export type Mark = 'high' | 'above' | 'low' | null;

export function markOf(n: GraphNode): Mark {
  const ratio = n.kind === 'source' ? n.noise : n.kind === 'user' ? n.load : undefined;
  if (ratio === undefined) return null;
  if (ratio >= 1.5) return 'high';
  if (ratio >= 1.2) return 'above';
  if (n.kind === 'user' && (n.teamAvgAlerts ?? 0) > 0 && ratio < 0.5) return 'low';
  return null;
}

export const MARK_COLOR: Record<Exclude<Mark, null>, string> = {
  high: 'var(--critical)',
  above: 'var(--warning)',
  low: 'var(--info)',
};

export function markText(n: GraphNode, mark: Mark): string | null {
  if (!mark) return null;
  if (n.kind === 'source')
    return i18n.t(mark === 'high' ? 'graph.mark.noisySystem' : 'graph.mark.louderThanAvg');
  return i18n.t(
    mark === 'high'
      ? 'graph.mark.overloaded'
      : mark === 'above'
        ? 'graph.mark.aboveTeamAvg'
        : 'graph.mark.fewNotifications',
  );
}

const num = { format: (n: number) => new Intl.NumberFormat(uiLocale()).format(n) };
const ratio = {
  format: (n: number) =>
    new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(n),
};

export const fmtNum = (n: number) => num.format(n);
export const fmtRatio = (r: number) => `${ratio.format(r)}×`;

/** 45 s · 12 min · 1 h 05 min · — */
export function fmtDuration(sec: number | null): string {
  if (sec === null) return '—';
  if (sec < 60) return `${Math.round(sec)} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** `label` is an i18n key, translated at render. */
export const RANGES = [
  { id: '24h', label: 'graph.range.24h', ms: 86_400_000 },
  { id: '7d', label: 'graph.range.7d', ms: 7 * 86_400_000 },
  { id: '14d', label: 'graph.range.14d', ms: 14 * 86_400_000 },
  { id: '30d', label: 'graph.range.30d', ms: 30 * 86_400_000 },
] as const;
export type RangeId = (typeof RANGES)[number]['id'];
