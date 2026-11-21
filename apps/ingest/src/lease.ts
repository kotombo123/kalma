import type { Redis } from '@alerting/config';

/**
 * One owner per key across ingest instances: `SET key owner NX PX ttl`, renewed while held.
 * Renew and release only touch the key if it still holds our token (a lease that expired and
 * was taken by another instance is never extended or deleted by us).
 */
export interface LeaseStore {
  acquire(key: string, owner: string, ttlMs: number): Promise<boolean>;
  renew(key: string, owner: string, ttlMs: number): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
}

const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export function redisLeases(redis: Redis): LeaseStore {
  return {
    async acquire(key, owner, ttlMs) {
      return (await redis.set(key, owner, 'PX', ttlMs, 'NX')) === 'OK';
    },
    async renew(key, owner, ttlMs) {
      return (await redis.eval(RENEW, 1, key, owner, ttlMs)) === 1;
    },
    async release(key, owner) {
      await redis.eval(RELEASE, 1, key, owner);
    },
  };
}

/** Same semantics in memory (unit tests). */
export function memoryLeases(now: () => number = Date.now): LeaseStore {
  const held = new Map<string, { owner: string; until: number }>();
  const holder = (key: string) => {
    const h = held.get(key);
    return h && h.until > now() ? h : undefined;
  };
  return {
    async acquire(key, owner, ttlMs) {
      if (holder(key)) return false;
      held.set(key, { owner, until: now() + ttlMs });
      return true;
    },
    async renew(key, owner, ttlMs) {
      const h = holder(key);
      if (h?.owner !== owner) return false;
      h.until = now() + ttlMs;
      return true;
    },
    async release(key, owner) {
      if (holder(key)?.owner === owner) held.delete(key);
    },
  };
}
