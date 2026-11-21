import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Redis, STREAM_ALERTS, recentEventsKey } from '@alerting/config';
import { AlertStreamMessage, NormalizedEvent, SEED } from '@alerting/contracts';
import { alertFromRow, createDb, eq, runMigrations, t, type Db } from '@alerting/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbAlerts, redisRecentEvents } from '../src/alerts.ts';
import { EventConsumer } from '../src/consumer.ts';
import { redisDedup } from '../src/dedup.ts';
import { processBatch } from '../src/pipeline.ts';
import { DbRules } from '../src/rules.ts';
import { DbSchemas } from '../src/schemas.ts';
import { readStreams } from '../src/stream-metrics.ts';
import { envelopes, loadRule } from './helpers.ts';

const hasDocker =
  !!process.env.CI ||
  !!process.env.DOCKER_HOST ||
  ['/var/run/docker.sock', `${homedir()}/.docker/run/docker.sock`].some((p) => existsSync(p));

/** The real path: stream:events → consumer group → Postgres alerts + stream:alerts + events:recent. */
// Real containers and 500-event batches: well over vitest's 5 s default on CI runners.
describe.skipIf(!hasDocker)('worker against Postgres + Redis', { timeout: 60_000 }, () => {
  let pg: StartedPostgreSqlContainer;
  let rd: StartedRedisContainer;
  let db: Db;
  let redis: Redis;
  let end: () => Promise<void>;

  beforeAll(async () => {
    [pg, rd] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    const conn = createDb(pg.getConnectionUri(), 8);
    db = conn.db;
    redis = new Redis(rd.getConnectionUrl());
    await runMigrations(db);

    await db.insert(t.orgs).values({ id: SEED.orgId, name: 'Kalma' });
    await db.insert(t.teams).values({ id: SEED.teams.settlements, orgId: SEED.orgId, name: 'Settlements' });
    await db
      .insert(t.systems)
      .values({ id: SEED.systems.workflowEngine, orgId: SEED.orgId, name: 'workflow engine' });
    await db.insert(t.sources).values({
      id: SEED.sources.http,
      orgId: SEED.orgId,
      systemId: SEED.systems.workflowEngine,
      name: 'http',
      transport: 'http',
      config: { transport: 'http' },
      apiKeyHash: 'x'.repeat(64),
      apiKeyPrefix: 'ak_demo_http',
    });
    const rule = loadRule('team-settlements.yaml');
    await db.insert(t.rules).values({
      id: rule.id,
      orgId: SEED.orgId,
      teamId: rule.teamId,
      name: rule.name,
      version: rule.version,
      definition: rule,
      origin: 'file',
    });
    end = async () => {
      await Promise.all([conn.sql.end(), redis.quit()]);
      await Promise.all([pg.stop(), rd.stop()]);
    };
  }, 120_000);

  afterAll(() => end?.());

  beforeEach(async () => {
    await redis.flushall();
    await db.delete(t.alerts);
    await db.delete(t.schemas);
  });

  /** N consumers in one group, each with its own connection, draining stream:events. */
  async function runWorkers(n: number) {
    const rules = new DbRules(db);
    await rules.reload();
    const schemas = new DbSchemas(db, redis);
    const alerts = new DbAlerts(db, redis, { validate: true });
    const conns = Array.from({ length: n }, () => redis.duplicate());
    const consumers = conns.map(
      (conn, i) =>
        new EventConsumer(
          conn,
          async (payloads) => {
            await processBatch(payloads, {
              schemas,
              rules,
              dedup: redisDedup(conn),
              alerts,
              recent: redisRecentEvents(conn, { validate: true }),
            });
          },
          { consumer: `test-${i}`, shards: 1, batchSize: 50, blockMs: 10 },
        ),
    );
    // Groups only: the test drives tick() itself. start() would also run the background loop,
    // which keeps consuming after the test's flush and loses the last count update.
    for (const c of consumers) await c.ensureGroups();
    await c0(consumers);
    await alerts.flush();
    await alerts.flush(); // retried updates whose alert row was committed by another worker
    await schemas.flush();
    await Promise.all(conns.map((c) => c.quit()));
  }

  async function c0(consumers: EventConsumer[]) {
    // Each consumer reads until the group has nothing left for it.
    await Promise.all(
      consumers.map(async (c) => {
        let idle = 0;
        while (idle < 3) idle = (await c.tick()) === 0 ? idle + 1 : 0;
      }),
    );
  }

  async function push(payloads: string[]) {
    const p = redis.pipeline();
    for (const d of payloads) p.xadd('stream:events', '*', 'd', d);
    await p.exec();
  }

  it('500 identical events → 1 alert with count 500, one stream:alerts message', async () => {
    await push(Array(500).fill(envelopes('events/workflow-failed.json')[0]));
    await runWorkers(1);

    const rows = await db.select().from(t.alerts);
    expect(rows).toHaveLength(1);
    const alert = alertFromRow(rows[0]!);
    expect(alert).toMatchObject({
      count: 500,
      status: 'open',
      groupKey: 'WF-20261023-00042',
      title: 'order-settlement failed at validate-counterparty',
    });
    expect(rows[0]!.dispatchedAt).toBeNull();

    const msgs = await redis.xrange(STREAM_ALERTS, '-', '+');
    expect(msgs).toHaveLength(1);
    expect(AlertStreamMessage.parse(JSON.parse(msgs[0]![1][1]!))).toMatchObject({ alertId: alert.id });

    const timeline = await db.select().from(t.alertTimeline).where(eq(t.alertTimeline.alertId, alert.id));
    expect(timeline.map((e) => e.kind)).toEqual(['created']);

    const recent = await redis.xrange(recentEventsKey(SEED.orgId), '-', '+');
    expect(recent.length).toBeGreaterThanOrEqual(500);
    expect(NormalizedEvent.parse(JSON.parse(recent[0]![1][1]!)).severity).toBe('error');
  });

  it('4 parallel consumers: still exactly 1 alert with count 500', async () => {
    await push(Array(500).fill(envelopes('events/workflow-failed.json')[0]));
    await runWorkers(4);
    const rows = await db.select().from(t.alerts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(500);
    expect(await redis.xlen(STREAM_ALERTS)).toBe(1);
  });

  it('an unknown JSON shows up as a schema with status new', async () => {
    await push(envelopes('events/judges-unknown.json'));
    await runWorkers(1);
    const [schema] = await db.select().from(t.schemas);
    expect(schema).toMatchObject({
      status: 'new',
      sourceId: SEED.sources.http,
      eventCount: 1,
      unmatchedCount: 1,
    });
    expect(schema!.fields.map((f) => f.path)).toContain('host.name');
    expect(schema!.guessedRoles.dedupKey?.path).toBe('incidentRef');
    expect(await db.select().from(t.alerts)).toHaveLength(0);
  });

  it('Alertmanager firing → resolved closes the alert in Postgres (B1-14)', async () => {
    const anna = loadRule('anna-payments-critical.yaml');
    await db
      .insert(t.teams)
      .values({ id: anna.teamId, orgId: SEED.orgId, name: 'Payments' })
      .onConflictDoNothing();
    await db
      .insert(t.rules)
      .values({
        id: anna.id,
        orgId: SEED.orgId,
        teamId: anna.teamId,
        name: anna.name,
        version: anna.version,
        definition: anna,
        origin: 'file',
      })
      .onConflictDoNothing();

    await push(envelopes('events/alertmanager-firing.json'));
    await runWorkers(1);
    await push(envelopes('events/alertmanager-resolved.json'));
    await runWorkers(1);

    const [row] = await db.select().from(t.alerts).where(eq(t.alerts.ruleId, anna.id));
    expect(row).toMatchObject({ status: 'resolved', resolvedBy: 'system' });
    expect(row!.resolvedAt).toBeTruthy();
    const timeline = await db.select().from(t.alertTimeline).where(eq(t.alertTimeline.alertId, row!.id));
    expect(timeline.map((e) => [e.kind, e.actorType])).toEqual([
      ['created', 'system'],
      ['resolve', 'system'],
    ]);
    expect(await redis.keys('dd:*')).toEqual([]);
  });

  it('acks every message (nothing left pending in the group)', async () => {
    await push(envelopes('events/workflow-failed.json'));
    await runWorkers(1);
    const [count] = (await redis.xpending('stream:events', 'workers')) as [number];
    expect(count).toBe(0);
  });

  it('stream metrics: length, group lag and pending', async () => {
    await redis.xgroup('CREATE', 'stream:events', 'workers', '0', 'MKSTREAM');
    for (let i = 0; i < 3; i++) await redis.xadd('stream:events', '*', 'd', '{}');
    await redis.xreadgroup('GROUP', 'workers', 'c1', 'COUNT', 1, 'STREAMS', 'stream:events', '>');
    const [events, alerts] = await readStreams(redis, 1);
    expect(events).toEqual({ stream: 'stream:events', group: 'workers', length: 3, lag: 2, pending: 1 });
    // No stream:alerts / notifier group yet.
    expect(alerts).toMatchObject({ stream: 'stream:alerts', length: 0, lag: 0 });
  });
});
