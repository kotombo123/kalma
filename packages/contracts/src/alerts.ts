import { z } from 'zod';
import { ChannelType, Id, IsoDate, Severity } from './common.ts';
import { Condition, Highlight } from './rules.ts';

export const AlertStatus = z.enum(['open', 'acknowledged', 'resolved']);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const AlertField = z.object({ label: z.string(), value: z.string(), highlight: Highlight.optional() });
export type AlertField = z.infer<typeof AlertField>;

export const Alert = z.object({
  id: Id,
  orgId: Id,
  ruleId: Id,
  ruleVersion: z.number().int(),
  teamId: Id,
  sourceId: Id,
  schemaId: Id,
  groupKey: z.string(),
  status: AlertStatus,
  severity: Severity,
  title: z.string(),
  body: z.string().optional(),
  fields: z.array(AlertField),
  color: z.string().optional(),
  count: z.number().int(),
  firstSeen: IsoDate,
  lastSeen: IsoDate,
  ingestTs: z.number(),
  lastEvent: z.object({ raw: z.unknown(), flat: z.record(z.string(), z.unknown()) }),
  /** distinct dedupKey in the group (max 20) */
  groupMembers: z.array(z.string()).optional(),
  runbookInstanceId: Id.optional(),
  ackBy: Id.optional(),
  ackAt: IsoDate.optional(),
  resolvedBy: z.string().optional(),
  resolvedAt: IsoDate.optional(),
  escalationLevel: z.number().int().optional(),
});
export type Alert = z.infer<typeof Alert>;

/** worker → notifier (`stream:alerts`, JSON in field `d`). */
export const AlertStreamMessage = z.object({ alertId: Id, orgId: Id, ruleId: Id, ingestTs: z.number() });
export type AlertStreamMessage = z.infer<typeof AlertStreamMessage>;

export const RunbookFormat = z.enum(['yaml', 'markdown', 'checklist', 'link', 'text']);
export type RunbookFormat = z.infer<typeof RunbookFormat>;

export const RunbookStep = z.object({
  id: z.string(),
  kind: z.enum(['manual', 'check', 'action', 'link', 'read']),
  text: z.string(),
  /** params may contain {{…}} templates */
  action: z.object({ type: z.string(), params: z.record(z.string(), z.unknown()) }).optional(),
  approval: z.enum(['none', 'required']).default('none'),
  /** e.g. "previous_failed", "retry_failed:2" */
  if: z.string().optional(),
  url: z.string().optional(),
});
export type RunbookStep = z.infer<typeof RunbookStep>;

export const Runbook = z.object({
  id: Id,
  orgId: Id,
  teamId: Id,
  name: z.string(),
  format: RunbookFormat,
  source: z.string(),
  matches: Condition.optional(),
  steps: z.array(RunbookStep),
  version: z.number().int(),
});
export type Runbook = z.infer<typeof Runbook>;

export const StepState = z.enum(['pending', 'running', 'waiting_approval', 'done', 'failed', 'skipped']);
export type StepState = z.infer<typeof StepState>;

/** Step with filled values and runtime state (`runbook_instances.steps`). */
export const RunbookInstanceStep = RunbookStep.extend({
  state: StepState,
  /** names of template values that could not be filled */
  missing: z.array(z.string()).default([]),
  result: z
    .object({ ok: z.boolean(), output: z.unknown().optional(), error: z.string().optional() })
    .optional(),
  attempts: z.number().int().default(0),
  approvalId: Id.optional(),
  completedBy: z.string().optional(),
  completedAt: IsoDate.optional(),
});
export type RunbookInstanceStep = z.infer<typeof RunbookInstanceStep>;

export const RunbookInstance = z.object({
  id: Id,
  alertId: Id,
  runbookId: Id,
  runbookVersion: z.number().int(),
  steps: z.array(RunbookInstanceStep),
});
export type RunbookInstance = z.infer<typeof RunbookInstance>;

export const ActionRisk = z.enum(['low', 'high']);
export type ActionRisk = z.infer<typeof ActionRisk>;

export interface ActionResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface ActionContext {
  alert: Alert;
  logger: {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
  };
  fetch: typeof fetch;
}

/** One file = one action type (`packages/actions/src/types/`). */
export interface ActionType<P = Record<string, unknown>> {
  name: string;
  risk: ActionRisk;
  title: string;
  params: z.ZodType<P>;
  execute(params: P, ctx: ActionContext): Promise<ActionResult>;
}

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired']);
export const Approval = z.object({
  id: Id,
  alertId: Id,
  stepId: z.string(),
  /** 4 chars, e.g. "7f3k" */
  code: z.string(),
  status: ApprovalStatus,
  requestedAt: IsoDate,
  decidedBy: z.string().optional(),
  decidedAt: IsoDate.optional(),
  via: z.enum(['ui', 'telegram', 'email']).optional(),
  /** human readable description of the step */
  text: z.string().optional(),
});
export type Approval = z.infer<typeof Approval>;

export const TimelineKind = z.enum([
  'created',
  'ack',
  'resolve',
  'step',
  'action',
  'approval',
  'delivery',
  'escalation',
  'comment',
]);
export type TimelineKind = z.infer<typeof TimelineKind>;

export const TimelineEntry = z.object({
  id: Id,
  alertId: Id,
  ts: IsoDate,
  actorType: z.enum(['user', 'system']),
  actorId: z.string().optional(),
  kind: TimelineKind,
  data: z.record(z.string(), z.unknown()).default({}),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const DeliveryState = z.enum(['pending', 'sending', 'sent', 'failed', 'skipped']);
export type DeliveryState = z.infer<typeof DeliveryState>;

export const DeliveryStatus = z.object({
  id: Id,
  alertId: Id,
  userId: Id,
  channel: ChannelType,
  status: DeliveryState,
  attempts: z.number().int(),
  lastError: z.string().optional(),
  sentAt: IsoDate.optional(),
  fallbackOf: Id.optional(),
});
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;
