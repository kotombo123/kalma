/**
 * B2-M4 resilience: circuit-breaker unit tests + throttle logic tests.
 * No containers needed — pure logic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isCircuitOpen,
  recordFailure,
  recordSuccess,
  resetBreakers,
} from '../src/circuit-breaker.ts';
import { checkThrottle, drainDigests, DIGEST_INTERVAL_MS } from '../src/throttle.ts';
import type { Redis } from '@alerting/config';

// ── Circuit Breaker ──────────────────────────────────────────────────────────

describe('circuit breaker', () => {
  beforeEach(() => resetBreakers());

  it('starts closed', () => {
    expect(isCircuitOpen('email')).toBe(false);
  });

  it('stays closed after 1–2 failures', () => {
    recordFailure('email');
    recordFailure('email');
    expect(isCircuitOpen('email')).toBe(false);
  });

  it('opens after 3 consecutive failures', () => {
    recordFailure('email');
    recordFailure('email');
    recordFailure('email');
    expect(isCircuitOpen('email')).toBe(true);
  });

  it('does not open telegram when only email fails', () => {
    recordFailure('email');
    recordFailure('email');
    recordFailure('email');
    expect(isCircuitOpen('telegram')).toBe(false);
  });

  it('closes immediately on success', () => {
    recordFailure('email');
    recordFailure('email');
    recordFailure('email');
    expect(isCircuitOpen('email')).toBe(true);
    recordSuccess('email');
    expect(isCircuitOpen('email')).toBe(false);
  });

  it('auto-resets after open duration', () => {
    const fakeNow = 1_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
    recordFailure('email');
    recordFailure('email');
    recordFailure('email');
    expect(isCircuitOpen('email')).toBe(true);

    // advance 61 seconds
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow + 61_000);
    expect(isCircuitOpen('email')).toBe(false);

    vi.restoreAllMocks();
  });

  it('failure count resets after success', () => {
    recordFailure('email');
    recordFailure('email');
    recordSuccess('email');
    // should need 3 more failures to open again
    recordFailure('email');
    recordFailure('email');
    expect(isCircuitOpen('email')).toBe(false);
    recordFailure('email');
    expect(isCircuitOpen('email')).toBe(true);
  });
});

// ── Throttle ─────────────────────────────────────────────────────────────────

function makeRedisMock(): Redis {
  const store = new Map<string, { value: string; expireAt: number }>();
  const sortedSets = new Map<string, Map<string, number>>();

  const r = {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry || Date.now() > entry.expireAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, unit: string, ttl: number): Promise<void> {
      const expireAt = unit === 'PX' ? Date.now() + ttl : Date.now() + ttl * 1000;
      store.set(key, { value, expireAt });
    },
    async decr(key: string): Promise<number> {
      const entry = store.get(key);
      if (!entry) return -1;
      const next = parseInt(entry.value, 10) - 1;
      store.set(key, { ...entry, value: String(next) });
      return next;
    },
    async expire(key: string, ttlS: number): Promise<void> {
      const entry = sortedSets.get(key);
      if (entry) {
        // just keep it, mock doesn't expire sorted sets in tests
      }
      void key; void ttlS;
    },
    async zadd(key: string, score: string, member: string): Promise<void> {
      const ss = sortedSets.get(key) ?? new Map<string, number>();
      ss.set(member, parseFloat(score));
      sortedSets.set(key, ss);
    },
    async zrange(key: string, _start: string, _end: string): Promise<string[]> {
      const ss = sortedSets.get(key);
      if (!ss) return [];
      return [...ss.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
    },
    async del(key: string): Promise<void> {
      store.delete(key);
      sortedSets.delete(key);
    },
    async scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
      // args: 'MATCH', pattern, 'COUNT', limit
      const matchIdx = (args as string[]).indexOf('MATCH');
      const pattern = matchIdx >= 0 ? String(args[matchIdx + 1]) : '*';
      const prefix = pattern.split('*')[0] ?? '';
      const keys = [...sortedSets.keys()].filter((k) => k.startsWith(prefix));
      return ['0', keys];
    },
  } as unknown as Redis;
  return r;
}

describe('throttle', () => {
  it('allows first 3 messages (bucket capacity)', async () => {
    const redis = makeRedisMock();
    expect(await checkThrottle(redis, 'u1', 'email', 'a1')).toBe(true);
    expect(await checkThrottle(redis, 'u1', 'email', 'a2')).toBe(true);
    expect(await checkThrottle(redis, 'u1', 'email', 'a3')).toBe(true);
  });

  it('throttles 4th message', async () => {
    const redis = makeRedisMock();
    await checkThrottle(redis, 'u1', 'email', 'a1');
    await checkThrottle(redis, 'u1', 'email', 'a2');
    await checkThrottle(redis, 'u1', 'email', 'a3');
    expect(await checkThrottle(redis, 'u1', 'email', 'a4')).toBe(false);
  });

  it('different users are independent', async () => {
    const redis = makeRedisMock();
    await checkThrottle(redis, 'u1', 'email', 'a1');
    await checkThrottle(redis, 'u1', 'email', 'a2');
    await checkThrottle(redis, 'u1', 'email', 'a3');
    expect(await checkThrottle(redis, 'u2', 'email', 'a4')).toBe(true);
  });

  it('different channels are independent', async () => {
    const redis = makeRedisMock();
    await checkThrottle(redis, 'u1', 'email', 'a1');
    await checkThrottle(redis, 'u1', 'email', 'a2');
    await checkThrottle(redis, 'u1', 'email', 'a3');
    expect(await checkThrottle(redis, 'u1', 'telegram', 'a4')).toBe(true);
  });

  it('drainDigests returns throttled entries and clears', async () => {
    const redisMock = makeRedisMock();
    // manually seed the digest sorted set
    await redisMock.zadd('digest:u1:email', String(Date.now()), 'a4');

    const entries = await drainDigests(redisMock);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.userId).toBe('u1');
    expect(entries[0]!.channel).toBe('email');
    expect(entries[0]!.alertIds).toContain('a4');
  });

  it('checkThrottle adds to digest when throttled', async () => {
    const redisMock = makeRedisMock();
    const zaddSpy = vi.spyOn(redisMock, 'zadd');

    await checkThrottle(redisMock, 'u1', 'email', 'a1');
    await checkThrottle(redisMock, 'u1', 'email', 'a2');
    await checkThrottle(redisMock, 'u1', 'email', 'a3');
    const throttled = await checkThrottle(redisMock, 'u1', 'email', 'a4');
    expect(throttled).toBe(false);
    expect(zaddSpy).toHaveBeenCalledWith('digest:u1:email', expect.any(String), 'a4');
  });

  it('DIGEST_INTERVAL_MS is 5 minutes', () => {
    expect(DIGEST_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
