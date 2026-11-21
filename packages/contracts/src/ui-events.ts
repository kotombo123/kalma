import { z } from 'zod';
import { Id } from './common.ts';
import { Alert, Approval, DeliveryStatus, TimelineEntry } from './alerts.ts';
import { SchemaInfo } from './sources.ts';

/** Published on `ui:{orgId}` (Redis Pub/Sub) and forwarded by api over WebSocket. */
export const UiEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('alert.created'), alert: Alert }),
  z.object({ type: z.literal('alert.updated'), alertId: Id, patch: Alert.partial() }),
  z.object({ type: z.literal('delivery.updated'), delivery: DeliveryStatus }),
  z.object({ type: z.literal('timeline.appended'), alertId: Id, entry: TimelineEntry }),
  z.object({ type: z.literal('approval.requested'), approval: Approval }),
  z.object({ type: z.literal('schema.discovered'), schema: SchemaInfo }),
]);
export type UiEvent = z.infer<typeof UiEvent>;

export const ConfigKind = z.enum([
  'rules',
  'mappings',
  'sources',
  'runbooks',
  'prefs',
  'oncall',
  'schemas',
  'teams',
]);
export type ConfigKind = z.infer<typeof ConfigKind>;

/** Published on `config:changed` — hot-reload of caches. */
export const ConfigChanged = z.object({
  kind: ConfigKind,
  orgId: Id,
  id: Id.optional(),
  version: z.number().int().optional(),
});
export type ConfigChanged = z.infer<typeof ConfigChanged>;
