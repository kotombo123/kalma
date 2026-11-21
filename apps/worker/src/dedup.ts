import { dedupKey, type Redis } from '@alerting/config';
import type { DedupPort, DedupResult } from './ports.ts';

/**
 * KEYS[1] = dd:{ruleId}:{groupKey}; ARGV = candidate alertId, window (s), now (ms).
 * First event in a window creates the hash with a TTL and wins (NEW); later ones bump the count.
 * Redis runs scripts atomically, so with N workers exactly one gets NEW.
 */
export const DEDUP_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('HSET', KEYS[1], 'alertId', ARGV[1], 'count', 1, 'lastSeen', ARGV[3])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
  return {'NEW', ARGV[1], 1}
end
local count = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HSET', KEYS[1], 'lastSeen', ARGV[3])
return {'DUP', redis.call('HGET', KEYS[1], 'alertId'), count}
`;

type DedupRedis = Redis & {
  dedup(key: string, alertId: string, windowSec: number, now: number): Promise<[string, string, number]>;
};

export function redisDedup(redis: Redis): DedupPort {
  if (!('dedup' in redis)) redis.defineCommand('dedup', { numberOfKeys: 1, lua: DEDUP_LUA });
  const r = redis as DedupRedis;
  return {
    async check(ruleId, groupKey, candidate, windowSec, nowMs) {
      const [result, alertId, count] = await r.dedup(dedupKey(ruleId, groupKey), candidate, windowSec, nowMs);
      return { result: result as DedupResult['result'], alertId, count: Number(count) };
    },
    async release(ruleId, groupKey) {
      await redis.del(dedupKey(ruleId, groupKey));
    },
  };
}

/** Same semantics in memory (unit tests, single process). */
export function memoryDedup(): DedupPort & {
  keys: Map<string, { alertId: string; count: number; expires: number }>;
} {
  const keys = new Map<string, { alertId: string; count: number; expires: number }>();
  return {
    keys,
    async check(ruleId, groupKey, candidate, windowSec, nowMs) {
      const key = dedupKey(ruleId, groupKey);
      const hit = keys.get(key);
      if (!hit || hit.expires <= nowMs) {
        keys.set(key, { alertId: candidate, count: 1, expires: nowMs + windowSec * 1000 });
        return { result: 'NEW', alertId: candidate, count: 1 };
      }
      hit.count++;
      return { result: 'DUP', alertId: hit.alertId, count: hit.count };
    },
    async release(ruleId, groupKey) {
      keys.delete(dedupKey(ruleId, groupKey));
    },
  };
}
