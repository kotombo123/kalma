/** Redis stream, pub/sub channel and key names (implementation_plan.md §5.6). Use only these helpers. */

export const STREAM_EVENTS = 'stream:events';
export const STREAM_ALERTS = 'stream:alerts';
export const GROUP_WORKERS = 'workers';
export const GROUP_NOTIFIERS = 'notifiers';

/** FNV-1a 32-bit — stable shard choice. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stream for a source's events. With 1 shard returns `stream:events`. */
export function streamFor(sourceId: string, shards = 1): string {
  return shards <= 1 ? STREAM_EVENTS : `${STREAM_EVENTS}:${hash(sourceId) % shards}`;
}

/** All event streams (for consumers). */
export function eventStreams(shards = 1): string[] {
  return shards <= 1 ? [STREAM_EVENTS] : Array.from({ length: shards }, (_, i) => `${STREAM_EVENTS}:${i}`);
}

export const recentEventsKey = (orgId: string) => `events:recent:${orgId}`;
export const RECENT_EVENTS_MAXLEN = 1000;
export const uiChannel = (orgId: string) => `ui:${orgId}`;
export const UI_CHANNEL_PATTERN = 'ui:*';
export const CONFIG_CHANGED = 'config:changed';
export const dedupKey = (ruleId: string, groupKey: string) => `dd:${ruleId}:${groupKey}`;
export const sourceLeaseKey = (sourceId: string) => `lease:source:${sourceId}`;
/** File sources: hash { ino, pos } — where the tailer stopped reading. */
export const sourceOffsetKey = (sourceId: string) => `offset:source:${sourceId}`;
/** Poll sources: ids already ingested (sorted set scored by time) and the `since` cursor. */
export const pollSeenKey = (sourceId: string) => `poll:seen:${sourceId}`;
export const pollCursorKey = (sourceId: string) => `poll:cursor:${sourceId}`;
export const RULES_SYNC_LEASE = 'lease:rules-sync';
export const CONNECTORS_SYNC_LEASE = 'lease:connectors-sync';
