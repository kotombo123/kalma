import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Redis, sourceLeaseKey } from '@alerting/config';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisOffsets } from '../src/file-tail.ts';
import { redisLeases } from '../src/lease.ts';
import { redisSink } from '../src/sink.ts';
import { redisPollState } from '../src/poll.ts';

const hasDocker =
  !!process.env.CI ||
  !!process.env.DOCKER_HOST ||
  ['/var/run/docker.sock', `${homedir()}/.docker/run/docker.sock`].some((p) => existsSync(p));

describe.skipIf(!hasDocker)('leases, offsets and poller state in Redis', { timeout: 60_000 }, () => {
  let rd: StartedRedisContainer;
  let redis: Redis;
  beforeAll(async () => {
    rd = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis(rd.getConnectionUrl());
  }, 120_000);
  afterAll(async () => {
    await redis?.quit();
    await rd?.stop();
  });

  it('one holder; only the holder renews or releases; expiry frees the lease', async () => {
    const leases = redisLeases(redis);
    const key = sourceLeaseKey('src-1');
    expect(await leases.acquire(key, 'a', 300)).toBe(true);
    expect(await leases.acquire(key, 'b', 300)).toBe(false);
    expect(await leases.renew(key, 'b', 300)).toBe(false);
    await leases.release(key, 'b'); // not b's: no effect
    expect(await redis.get(key)).toBe('a');
    expect(await leases.renew(key, 'a', 300)).toBe(true);

    await new Promise((r) => setTimeout(r, 400));
    expect(await leases.acquire(key, 'b', 300)).toBe(true);
    expect(await leases.renew(key, 'a', 300)).toBe(false); // a lost it
    await leases.release(key, 'b');
    expect(await redis.exists(key)).toBe(0);
  });

  it('offsets survive a restart', async () => {
    const offsets = redisOffsets(redis);
    expect(await offsets.get('src-1')).toBeUndefined();
    await offsets.set('src-1', { ino: 42, pos: 1234 });
    expect(await redisOffsets(redis).get('src-1')).toEqual({ ino: 42, pos: 1234 });
  });

  it('poller: seen ids expire after the TTL; the cursor persists', async () => {
    const state = redisPollState(redis);
    const t0 = Date.now();
    await state.markSeen('src-2', ['a', 'b'], t0, 1000);
    expect(await state.unseen('src-2', ['a', 'b', 'c'])).toEqual(new Set(['c']));
    // A later write prunes entries older than the TTL.
    await state.markSeen('src-2', ['c'], t0 + 2000, 1000);
    expect(await state.unseen('src-2', ['a', 'b', 'c'])).toEqual(new Set(['a', 'b']));

    expect(await state.cursor('src-2')).toBeUndefined();
    await state.setCursor('src-2', '2026-11-21T10:00:00.000Z');
    expect(await redisPollState(redis).cursor('src-2')).toBe('2026-11-21T10:00:00.000Z');
  });

  it('backlog: entries the worker group has not read, not the stream length', async () => {
    const sink = redisSink(redis);
    await sink.add('stream:backlog', ['{}', '{}']);
    expect(await sink.backlog('stream:backlog')).toBe(2); // no group yet
    await redis.xgroup('CREATE', 'stream:backlog', 'workers', '0');
    await sink.add('stream:backlog', ['{}']);
    expect(await sink.backlog('stream:backlog')).toBe(3);
    await redis.xreadgroup('GROUP', 'workers', 'w1', 'COUNT', 3, 'STREAMS', 'stream:backlog', '>');
    expect(await redis.xlen('stream:backlog')).toBe(3);
    expect(await sink.backlog('stream:backlog')).toBe(0);
  });
});
