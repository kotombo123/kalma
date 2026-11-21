import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Redis } from '@alerting/config';
import { Envelope, SEED, SEED_API_KEYS } from '@alerting/contracts';
import { readFixture } from '@alerting/contracts/fixtures';
import { createDb, runMigrations, t } from '@alerting/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { redisSink } from '../src/sink.ts';
import { dbSourceLoader, sha256, SourceCache } from '../src/sources.ts';

const hasDocker =
  !!process.env.CI ||
  !!process.env.DOCKER_HOST ||
  ['/var/run/docker.sock', `${homedir()}/.docker/run/docker.sock`].some((p) => existsSync(p));

/** Real Postgres (migrated, one source) + real Redis: the path `pnpm send-event` takes. */
describe.skipIf(!hasDocker)('ingest against Postgres + Redis', () => {
  let pg: StartedPostgreSqlContainer;
  let rd: StartedRedisContainer;
  let redis: Redis;
  let close: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    [pg, rd] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    const { db, sql } = createDb(pg.getConnectionUri(), 2);
    await runMigrations(db);
    await db.insert(t.orgs).values({ id: SEED.orgId, name: 'Kalma' });
    await db.insert(t.systems).values({ id: SEED.systems.payments, orgId: SEED.orgId, name: 'payments' });
    await db.insert(t.sources).values({
      id: SEED.sources.http,
      orgId: SEED.orgId,
      systemId: SEED.systems.payments,
      name: 'Alertmanager webhook',
      transport: 'http',
      config: { transport: 'http' },
      format: 'auto',
      apiKeyHash: sha256(SEED_API_KEYS.http),
      apiKeyPrefix: SEED_API_KEYS.http.slice(0, 12),
    });
    redis = new Redis(rd.getConnectionUrl());
    app = await buildApp({
      sources: new SourceCache(dbSourceLoader(db)),
      sink: redisSink(redis),
      config: { validate: true },
    });
    close = async () => {
      await app.close();
      await Promise.all([sql.end(), redis.quit()]);
      await Promise.all([pg.stop(), rd.stop()]);
    };
  }, 120_000);

  afterAll(() => close?.());

  it('POST → XADD stream:events with field d = Envelope JSON', async () => {
    const body = readFixture('events/alertmanager-firing.json');
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${SEED.sources.http}`,
      payload: body,
      headers: { 'content-type': 'application/json', 'x-api-key': SEED_API_KEYS.http },
    });
    expect(res.statusCode).toBe(202);

    const entries = await redis.xrange('stream:events', '-', '+');
    expect(entries).toHaveLength(1);
    const [, fields] = entries[0]!;
    expect(fields[0]).toBe('d');
    const envelope = Envelope.parse(JSON.parse(fields[1]!));
    expect(envelope).toMatchObject({ orgId: SEED.orgId, sourceId: SEED.sources.http, raw: JSON.parse(body) });
  });

  it('rejects a wrong key against the stored hash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/ingest/${SEED.sources.http}`,
      payload: '{}',
      headers: { 'content-type': 'application/json', 'x-api-key': SEED_API_KEYS.kafka },
    });
    expect(res.statusCode).toBe(401);
  });
});
