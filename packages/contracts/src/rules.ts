import { z } from 'zod';
import { ChannelType, Id, Severity } from './common.ts';

export const Op = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'contains',
  'matches',
  'glob',
  'exists',
]);
export type Op = z.infer<typeof Op>;

/**
 * Condition tree. `field` is a path in `flat` ("payload.notional") or a normalized field:
 * "$severity", "$source", "$schema", "$status", "$entity", "$title".
 */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { field: string; op: Op; value?: unknown };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(Condition) }).strict(),
    z.object({ any: z.array(Condition) }).strict(),
    z.object({ not: Condition }).strict(),
    z.object({ field: z.string(), op: Op, value: z.unknown().optional() }).strict(),
  ]),
);

export const RoutingTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('team'), teamId: Id }),
  z.object({ type: z.literal('user'), userId: Id }),
  z.object({ type: z.literal('oncall'), teamId: Id }),
]);
export type RoutingTarget = z.infer<typeof RoutingTarget>;

export const Highlight = z.enum(['red', 'amber', 'green']);

export const Presentation = z.object({
  titleTemplate: z.string(),
  bodyTemplate: z.string().optional(),
  fields: z
    .array(z.object({ label: z.string(), template: z.string(), highlight: Highlight.optional() }))
    .default([]),
  severity: Severity.optional(),
  color: z.string().optional(),
});
export type Presentation = z.infer<typeof Presentation>;

export const Rule = z.object({
  id: Id,
  orgId: Id,
  teamId: Id,
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  version: z.number().int().default(1),
  /** Candidate index. */
  scope: z.object({ sourceIds: z.array(Id).optional(), schemaIds: z.array(Id).optional() }).optional(),
  condition: Condition,
  presentation: Presentation,
  /** keyTemplate defaults to the mapping's dedupKey. */
  dedup: z.object({ keyTemplate: z.string().optional(), windowSec: z.number().int().positive() }),
  grouping: z.object({ by: z.array(z.string()), windowSec: z.number().int().positive() }).optional(),
  routing: z.object({
    targets: z.array(RoutingTarget),
    /** missing = recipient preferences */
    channels: z.array(ChannelType).optional(),
    escalation: z.object({ afterMin: z.number().positive(), maxLevel: z.number().int().min(1) }).optional(),
  }),
  runbookId: Id.optional(),
  autoResolve: z
    .object({ onSourceResolved: z.boolean(), onRunbookSuccess: z.boolean() })
    .default({ onSourceResolved: true, onRunbookSuccess: false }),
  origin: z.enum(['ui', 'api', 'file']).default('ui'),
});
export type Rule = z.infer<typeof Rule>;
export type RuleInput = z.input<typeof Rule>;

/**
 * YAML rule file (`config/rules/*.yaml`): same object, but `id`/`orgId` are optional and
 * `team` / `runbook` may be given by name (resolved by the YAML sync).
 */
export const RuleFile = Rule.extend({
  id: Id.optional(),
  orgId: Id.optional(),
  teamId: Id.optional(),
  team: z.string().optional(),
  runbook: z.string().optional(),
  routing: Rule.shape.routing.extend({
    targets: z.array(
      z.union([
        RoutingTarget,
        z.object({ type: z.enum(['team', 'oncall']), team: z.string() }),
        z.object({ type: z.literal('user'), email: z.string() }),
      ]),
    ),
  }),
});
export type RuleFile = z.infer<typeof RuleFile>;
