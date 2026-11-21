import { recentEventsKey, type Redis } from '@alerting/config';
import { NormalizedEvent } from '@alerting/contracts';

/** Max length of `events:recent:{orgId}` (the worker trims it). */
export const RECENT_EVENTS = 1000;

/**
 * Newest-first events from `events:recent:{orgId}` (worker writes `NormalizedEvent` JSON in field `d`).
 * Entries that do not validate are skipped.
 */
export async function recentEvents(
  redis: Redis,
  orgId: string,
  opts: { count?: number; filter?: (e: NormalizedEvent) => boolean; limit?: number } = {},
): Promise<NormalizedEvent[]> {
  const entries = await redis.xrevrange(
    recentEventsKey(orgId),
    '+',
    '-',
    'COUNT',
    opts.count ?? RECENT_EVENTS,
  );
  const out: NormalizedEvent[] = [];
  for (const [, fields] of entries) {
    if (opts.limit !== undefined && out.length >= opts.limit) break;
    const i = fields.indexOf('d');
    if (i < 0 || fields[i + 1] === undefined) continue;
    let json: unknown;
    try {
      json = JSON.parse(fields[i + 1]!);
    } catch {
      continue;
    }
    const ev = NormalizedEvent.safeParse(json);
    if (ev.success && (!opts.filter || opts.filter(ev.data))) out.push(ev.data);
  }
  return out;
}
