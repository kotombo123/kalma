import { z } from 'zod';
import { ChannelType, Id, IsoDate } from './common.ts';
import { DeliveryState } from './alerts.ts';

/** Columns of the dependency graph (F-20): sources → rules → teams → people. */
export const GraphNodeKind = z.enum(['source', 'rule', 'team', 'user']);
export type GraphNodeKind = z.infer<typeof GraphNodeKind>;

export const RuleCount = z.object({ ruleId: Id, name: z.string(), alerts: z.number().int() });
export type RuleCount = z.infer<typeof RuleCount>;

export const GraphNode = z.object({
  /** `${kind}:${entityId}` — unique across kinds. */
  id: z.string(),
  kind: GraphNodeKind,
  entityId: Id,
  label: z.string(),
  /** Source: its name (label is the system); rule: its team. */
  sublabel: z.string().optional(),
  /** Alerts in the range (for a person: alerts they were notified about). */
  alerts: z.number().int(),
  acked: z.number().int(),
  resolved: z.number().int(),
  /** Mean time to acknowledge / resolve in seconds; null without data. */
  mttaSec: z.number().nullable(),
  mttrSec: z.number().nullable(),
  topRules: z.array(RuleCount),
  /** Source: system id, events behind its alerts, and alerts / mean alerts of all sources. */
  systemId: Id.optional(),
  events: z.number().int().optional(),
  noise: z.number().optional(),
  /** Person: notifications, escalations, team average of alerts and alerts / that average. */
  notifications: z.number().int().optional(),
  escalations: z.number().int().optional(),
  teamAvgAlerts: z.number().optional(),
  load: z.number().optional(),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdgeKind = z.enum(['alerts', 'notifications', 'escalations']);
export type GraphEdgeKind = z.infer<typeof GraphEdgeKind>;

export const GraphEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: GraphEdgeKind,
  weight: z.number().int(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

/** `GET /graph?from&to&teamId` */
export const GraphResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
});
export type GraphResponse = z.infer<typeof GraphResponse>;

/** `GET /stats?from&to&teamId` */
export const StatsResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  totals: z.object({
    alerts: z.number().int(),
    open: z.number().int(),
    acknowledged: z.number().int(),
    resolved: z.number().int(),
    mttaSec: z.number().nullable(),
    mttrSec: z.number().nullable(),
  }),
  alertsPerHour: z.array(z.object({ hour: IsoDate, alerts: z.number().int() })),
  topRules: z.array(RuleCount.extend({ events: z.number().int() })),
  channels: z.array(
    z.object({ channel: ChannelType, counts: z.partialRecord(DeliveryState, z.number().int()) }),
  ),
});
export type StatsResponse = z.infer<typeof StatsResponse>;
