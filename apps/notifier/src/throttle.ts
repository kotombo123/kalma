/**
 * B2-05 throttling: Redis token-bucket per (userId, channel).
 * Rate: max 3 notifications per 5 minutes per channel.
 * Excess deliveries are queued in a digest (sorted set) and flushed
 * as a single bundled message once per DIGEST_INTERVAL_MS.
 *
 * Keys:
 *   tb:{userId}:{channel}       — token bucket (string, count remaining)
 *   digest:{userId}:{channel}   — sorted set of alertId, score = insertion ts
 */
import type { Redis } from '@alerting/config';

const BUCKET_CAPACITY = 3;
const BUCKET_REFILL_MS = 5 * 60 * 1000; // 5 minutes
const DIGEST_INTERVAL_MS = 5 * 60 * 1000;
const DIGEST_KEY_TTL_S = 600;

function tbKey(userId: string, channel: string): string {
  return `tb:${userId}:${channel}`;
}
function digestKey(userId: string, channel: string): string {
  return `digest:${userId}:${channel}`;
}

/**
 * Returns true if the delivery may proceed (token consumed).
 * Returns false if throttled — the alertId is added to the digest queue.
 */
export async function checkThrottle(
  redis: Redis,
  userId: string,
  channel: string,
  alertId: string,
): Promise<boolean> {
  const key = tbKey(userId, channel);

  const current = await redis.get(key);
  const tokens = current === null ? BUCKET_CAPACITY : parseInt(current, 10);

  if (tokens > 0) {
    const ttlMs = current === null ? BUCKET_REFILL_MS : undefined;
    if (ttlMs !== undefined) {
      await redis.set(key, String(tokens - 1), 'PX', ttlMs);
    } else {
      await redis.decr(key);
    }
    return true;
  }

  // Throttled — add to digest
  const dKey = digestKey(userId, channel);
  await redis.zadd(dKey, String(Date.now()), alertId);
  await redis.expire(dKey, DIGEST_KEY_TTL_S);
  return false;
}

export interface DigestEntry {
  userId: string;
  channel: string;
  alertIds: string[];
}

/**
 * Returns all digest queues that have entries and clears them.
 * Called by the digest flusher loop.
 */
export async function drainDigests(redis: Redis): Promise<DigestEntry[]> {
  const pattern = 'digest:*:*';
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');

  const result: DigestEntry[] = [];
  for (const key of keys) {
    const parts = key.split(':');
    if (parts.length < 3) continue;
    const userId = parts[1]!;
    const channel = parts.slice(2).join(':');

    const alertIds = await redis.zrange(key, '0', '-1');
    if (alertIds.length === 0) continue;

    await redis.del(key);
    result.push({ userId, channel, alertIds });
  }
  return result;
}

export { DIGEST_INTERVAL_MS };
