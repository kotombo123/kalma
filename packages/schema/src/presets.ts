import type { FieldRole, FlatRecord, Mapping, RoleBinding, Severity } from '@alerting/contracts';
import { normalizePath } from './fingerprint.ts';

/**
 * Path syntax used in presets:
 * - `a|b|c` — alternatives, the first one present in the event wins;
 * - `labels.*` — any field under `labels` (only in `requires`);
 * - array paths use the concrete index of the first item (`alerts[0].labels.severity`).
 */
export interface Preset {
  id: string;
  name: string;
  description: string;
  /** Every entry must be present for the preset to match. */
  requires: string[];
  /** Added to the match score; generic presets go negative so specific ones win. */
  priority?: number;
  roles: Partial<Record<FieldRole, RoleBinding>>;
  severityMap?: Record<string, Severity>;
  resolvedValues?: string[];
}

export type PresetMapping = Pick<Mapping, 'roles' | 'severityMap' | 'resolvedValues' | 'presetId'>;

export const PRESETS: Preset[] = [
  {
    id: 'alertmanager',
    name: 'Prometheus Alertmanager (single alert)',
    description: 'One Alertmanager alert: alertname, labels, annotations, startsAt, status.',
    requires: ['alertname|labels.alertname', 'labels.*', 'annotations.*', 'startsAt', 'status'],
    roles: {
      severity: { path: 'labels.severity' },
      timestamp: { path: 'startsAt' },
      title: { path: 'annotations.summary|annotations.description|alertname|labels.alertname' },
      message: { path: 'annotations.description|annotations.summary' },
      status: { path: 'status' },
      entity: { path: 'labels.service|labels.job|labels.instance' },
      dedupKey: { path: 'alertname|labels.alertname' },
    },
    resolvedValues: ['resolved'],
  },
  {
    id: 'alertmanager-webhook',
    name: 'Prometheus Alertmanager (webhook, grouped)',
    description: 'Alertmanager webhook payload with an alerts[] array; maps the first alert.',
    requires: ['version', 'groupKey', 'status', 'alerts[].labels.*'],
    roles: {
      severity: { path: 'alerts[0].labels.severity|commonLabels.severity' },
      timestamp: { path: 'alerts[0].startsAt' },
      title: { path: 'alerts[0].annotations.summary|commonAnnotations.summary|alerts[0].labels.alertname' },
      message: { path: 'alerts[0].annotations.description|commonAnnotations.description' },
      status: { path: 'status' },
      entity: { path: 'alerts[0].labels.service|commonLabels.service|alerts[0].labels.instance' },
      dedupKey: { path: 'groupKey' },
    },
    resolvedValues: ['resolved'],
  },
  {
    id: 'cloudevents',
    name: 'CloudEvents (structured JSON)',
    description: 'CNCF CloudEvents 1.0: specversion, id, source, type, time, data.',
    requires: ['specversion', 'id', 'source', 'type'],
    roles: {
      severity: { path: 'data.severity|data.level|severity' },
      timestamp: { path: 'time' },
      title: { path: 'data.title|data.summary|data.message|type' },
      message: { path: 'data.message|data.description' },
      status: { path: 'data.status|data.state' },
      entity: { path: 'subject|source' },
      dedupKey: { template: '{{source}}:{{type}}:{{subject}}' },
    },
  },
  {
    id: 'sentry',
    name: 'Sentry webhook (issue / event alert)',
    description: 'Sentry integration webhook: action + data.event or data.issue.',
    requires: ['action', 'data.event.title|data.issue.title', 'data.event.level|data.issue.level'],
    roles: {
      severity: { path: 'data.event.level|data.issue.level' },
      timestamp: { path: 'data.event.timestamp|data.event.datetime|data.issue.lastSeen' },
      title: { path: 'data.event.title|data.issue.title' },
      message: { path: 'data.event.culprit|data.issue.culprit' },
      status: { path: 'action' },
      entity: { path: 'data.event.project|data.issue.project.slug' },
      dedupKey: { path: 'data.event.issue_id|data.issue.id' },
    },
    resolvedValues: ['resolved'],
  },
  {
    id: 'github-workflow-run',
    name: 'GitHub Actions (workflow_run)',
    description: 'GitHub workflow_run webhook; conclusion drives severity and status.',
    requires: ['workflow_run.name', 'workflow_run.conclusion', 'repository.full_name'],
    roles: {
      severity: { path: 'workflow_run.conclusion' },
      timestamp: { path: 'workflow_run.updated_at|workflow_run.created_at' },
      title: {
        template:
          'Workflow {{workflow_run.name}} {{workflow_run.conclusion}} on {{workflow_run.head_branch}}',
      },
      message: { path: 'workflow_run.html_url' },
      status: { path: 'workflow_run.conclusion' },
      entity: { path: 'repository.full_name' },
      dedupKey: { template: '{{repository.full_name}}:{{workflow_run.name}}:{{workflow_run.head_branch}}' },
    },
    severityMap: {
      failure: 'error',
      timed_out: 'error',
      startup_failure: 'error',
      cancelled: 'warning',
      action_required: 'warning',
      success: 'info',
      skipped: 'info',
      neutral: 'info',
    },
    resolvedValues: ['success'],
  },
  {
    id: 'workflow-event',
    name: 'Workflow event',
    description: 'Workflow engine event: workflowId, type or state, error details.',
    requires: ['workflowId', 'type|state|status'],
    roles: {
      severity: { path: 'severity|level' },
      timestamp: { path: 'timestamp|ts|time' },
      title: { path: 'error.message|message|type' },
      message: { path: 'error.message|message' },
      status: { path: 'status|state' },
      entity: { path: 'workflowId' },
      dedupKey: { path: 'workflowId' },
    },
    resolvedValues: ['resolved', 'completed', 'succeeded', 'recovered'],
  },
  {
    id: 'meta-payload',
    name: 'Meta / payload envelope',
    description: 'Business event wrapped as { meta: { schema, producer, ts }, payload: {…} }.',
    requires: ['meta.schema|meta.type|meta.event', 'payload.*'],
    priority: -1,
    roles: {
      severity: { path: 'payload.severity|meta.severity|payload.level' },
      timestamp: { path: 'meta.ts|meta.time|meta.timestamp' },
      title: { path: 'payload.reason|payload.message|payload.title|meta.schema|meta.type' },
      message: { path: 'payload.message|payload.description' },
      status: { path: 'payload.status|meta.status' },
      entity: { path: 'payload.tradeId|payload.id|payload.entityId|meta.producer' },
    },
  },
  {
    id: 'structured-log',
    name: 'Structured log (logfmt / syslog / JSON log line)',
    description: 'Log line with a level and a message: ts, level, service, msg.',
    requires: ['level|lvl|severity|loglevel', 'msg|message'],
    priority: -2,
    roles: {
      severity: { path: 'level|lvl|severity|loglevel' },
      timestamp: { path: 'ts|time|timestamp|@timestamp' },
      title: { path: 'msg|message' },
      message: { path: 'msg|message' },
      entity: { path: 'service|app|logger|host|hostname' },
    },
  },
];

/** Normalized paths of the event plus every parent prefix, for `x.*` checks. */
function pathIndex(flat: FlatRecord): { exact: Set<string>; parents: Set<string> } {
  const exact = new Set<string>();
  const parents = new Set<string>();
  for (const path of Object.keys(flat)) {
    const norm = normalizePath(path);
    exact.add(norm);
    for (let i = norm.indexOf('.'); i !== -1; i = norm.indexOf('.', i + 1)) parents.add(norm.slice(0, i));
  }
  return { exact, parents };
}

function present(spec: string, index: ReturnType<typeof pathIndex>): boolean {
  return spec.split('|').some((alt) => {
    const norm = normalizePath(alt);
    return norm.endsWith('.*') ? index.parents.has(norm.slice(0, -2)) : index.exact.has(norm);
  });
}

/** First alternative that exists in the event, or undefined. */
const resolvePath = (spec: string, flat: FlatRecord) => spec.split('|').find((alt) => alt in flat);

/** The preset's mapping with alternatives resolved against this event; absent roles are dropped. */
export function presetMapping(preset: Preset, flat: FlatRecord): PresetMapping {
  const roles: PresetMapping['roles'] = {};
  for (const [role, binding] of Object.entries(preset.roles) as [FieldRole, RoleBinding][]) {
    if (binding.path === undefined) roles[role] = binding;
    else {
      const path = resolvePath(binding.path, flat);
      if (path) roles[role] = { path };
    }
  }
  return {
    roles,
    severityMap: preset.severityMap,
    resolvedValues: preset.resolvedValues,
    presetId: preset.id,
  };
}

/** Matching presets, most specific first (more requirements + priority). */
export function matchPresets(flat: FlatRecord, presets: Preset[] = PRESETS): Preset[] {
  const index = pathIndex(flat);
  return presets
    .filter((p) => p.requires.every((spec) => present(spec, index)))
    .map((p) => ({ p, score: p.requires.length + (p.priority ?? 0) }))
    .sort((a, b) => b.score - a.score)
    .map(({ p }) => p);
}

/** Best preset for the event with its resolved mapping, or undefined if none matches. */
export function detectPreset(
  flat: FlatRecord,
  presets: Preset[] = PRESETS,
): { preset: Preset; mapping: PresetMapping } | undefined {
  const preset = matchPresets(flat, presets)[0];
  return preset && { preset, mapping: presetMapping(preset, flat) };
}
