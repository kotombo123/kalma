import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Redis } from '@alerting/config';
import { Envelope, SEED } from '@alerting/contracts';
import { readFixture } from '@alerting/contracts/fixtures';
import { createDb, eq, runMigrations, t, type Db } from '@alerting/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import { CompressionTypes, Kafka, logLevel, Partitioners, type Producer } from 'kafkajs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbKafkaSources, groupIdFor, KafkaManager, kafkajsConsumers } from '../src/kafka.ts';
import { redisSink } from '../src/sink.ts';

const hasDocker =
  !!process.env.CI ||
  !!process.env.DOCKER_HOST ||
  ['/var/run/docker.sock', `${homedir()}/.docker/run/docker.sock`].some((p) => existsSync(p));

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Real Redpanda + Postgres + Redis: a source added in the DB starts consuming without restart. */
describe.skipIf(!hasDocker)('kafka ingest against Redpanda', { timeout: 60_000 }, () => {
  let kafkaC: StartedRedpandaContainer;
  let pg: StartedPostgreSqlContainer;
  let rd: StartedRedisContainer;
  let db: Db;
  let redis: Redis;
  let kafka: Kafka;
  let producer: Producer;
  let manager: KafkaManager;
  let close: () => Promise<void>;

  beforeAll(async () => {
    [kafkaC, pg, rd] = await Promise.all([
      new RedpandaContainer('redpandadata/redpanda:v24.2.7').start(),
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    const conn = createDb(pg.getConnectionUri(), 2);
    db = conn.db;
    await runMigrations(db);
    await db.insert(t.orgs).values({ id: SEED.orgId, name: 'Kalma' });
    await db
      .insert(t.systems)
      .values({ id: SEED.systems.workflowEngine, orgId: SEED.orgId, name: 'workflow engine' });
    redis = new Redis(rd.getConnectionUrl());

    const brokers = [kafkaC.getBootstrapServers()];
    kafka = new Kafka({ clientId: 'test', brokers, logLevel: logLevel.NOTHING });
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({ topics: [{ topic: 'workflow-events' }], waitForLeaders: true });
    await admin.disconnect();
    producer = kafka.producer({ createPartitioner: Partitioners.DefaultPartitioner });
    await producer.connect();

    manager = new KafkaManager(dbKafkaSources(db), kafkajsConsumers(brokers), redisSink(redis), {
      eventStreamShards: 1,
      validate: true,
    });
    close = async () => {
      await manager.stopAll();
      await producer.disconnect();
      await Promise.all([conn.sql.end(), redis.quit()]);
      await Promise.all([kafkaC.stop(), pg.stop(), rd.stop()]);
    };
  }, 180_000);

  afterAll(() => close?.());

  it('adding a kafka source starts its consumer; messages land on stream:events', async () => {
    await manager.sync();
    expect(manager.active).toEqual([]);

    await db.insert(t.sources).values({
      id: SEED.sources.kafka,
      orgId: SEED.orgId,
      systemId: SEED.systems.workflowEngine,
      name: 'Kafka workflow-events',
      transport: 'kafka',
      config: { transport: 'kafka', topic: 'workflow-events', fromBeginning: true },
      format: 'json',
      apiKeyHash: 'x'.repeat(64),
      apiKeyPrefix: 'ak_demo_kafk',
    });
    await manager.sync(); // what config:changed (kind sources) triggers
    expect(manager.active).toEqual([SEED.sources.kafka]);

    const body = readFixture('events/workflow-failed.json');
    // One plain and one Snappy batch (rpk's and many Java producers' default).
    await producer.send({ topic: 'workflow-events', messages: [{ value: body }] });
    await producer.send({
      topic: 'workflow-events',
      compression: CompressionTypes.Snappy,
      messages: [{ value: body }],
    });

    const entries = await until(
      () => redis.xrange('stream:events', '-', '+'),
      (e) => e.length >= 2,
    );
    expect(entries).toHaveLength(2);
    const envelope = Envelope.parse(JSON.parse(entries[0]![1][1]!));
    expect(envelope).toMatchObject({
      sourceId: SEED.sources.kafka,
      format: 'json',
      raw: { workflowId: 'WF-20261023-00042' },
    });

    // Offsets are committed after XADD: the group's committed offset reaches the end.
    const admin = kafka.admin();
    await admin.connect();
    const committed = await until(
      () => admin.fetchOffsets({ groupId: groupIdFor(SEED.sources.kafka), topics: ['workflow-events'] }),
      (o) => o[0]!.partitions.reduce((n, p) => n + Number(p.offset), 0) === 2,
    );
    await admin.disconnect();
    expect(committed[0]!.partitions.reduce((n, p) => n + Number(p.offset), 0)).toBe(2);
  });

  it('disabling the source stops its consumer', async () => {
    await db.update(t.sources).set({ enabled: false }).where(eq(t.sources.id, SEED.sources.kafka));
    await manager.sync();
    expect(manager.active).toEqual([]);
  });
});
