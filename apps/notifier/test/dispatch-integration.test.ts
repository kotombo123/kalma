/**
 * Integration test: notifier dispatch pipeline on a real Postgres + Redis.
 * Guards against the Alert.parse(row) → ZodError regression (all nullable
 * DB columns must survive the alertFromRow mapper without throwing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Redis } from '@alerting/config';
import { createDb, runMigrations, alertFromRow, t } from '@alerting/db';
import { newId } from '@alerting/config';
import { dispatchAlert } from '../src/dispatch.ts';
import type { Logger } from '@alerting/config';

const TEST_TIMEOUT = 120_000;

interface TestCtx {
  db: ReturnType<typeof createDb>['db'];
  redis: Redis;
  orgId: string;
  ruleId: string;
  stop: () => Promise<void>;
}

let ctx: TestCtx;

/** Minimal alert row — only NOT NULL fields. All optional/nullable fields omitted (become null in DB). */
function minimalAlertValues(overrides: { id: string; orgId: string; ruleId: string }) {
  return {
    id: overrides.id,
    orgId: overrides.orgId,
    ruleId: overrides.ruleId,
    ruleVersion: 1,
    teamId: 'team_stub',
    sourceId: 'source_stub',
    schemaId: 'schema_stub',
    groupKey: 'test-group',
    status: 'open' as const,
    severity: 'critical' as const,
    title: 'Test alert',
    count: 1,
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    ingestTs: Date.now(),
    lastEvent: { raw: {}, flat: {}, normalized: {} },
    fields: [],
  };
}

beforeAll(async () => {
  const [pg, rd] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);

  const { db, sql } = createDb(pg.getConnectionUri(), 2);
  const redis = new Redis(rd.getConnectionUrl());

  await runMigrations(db);

  const orgId = newId();
  const ruleId = newId();

  // Minimal org + rule (alerts table has no FK constraint on ruleId/sourceId/schemaId/teamId)
  await db.insert(t.orgs).values({ id: orgId, name: 'Integration Test Org' });

  ctx = {
    db,
    redis,
    orgId,
    ruleId,
    stop: async () => {
      await redis.quit();
      await sql.end();
      await pg.stop();
      await rd.stop();
    },
  };
}, TEST_TIMEOUT);

afterAll(async () => ctx?.stop());

const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
} as unknown as Logger;

describe('alertFromRow', () => {
  it('parses raw DB row with all nullable fields null — no ZodError', async () => {
    const { db, orgId, ruleId } = ctx;
    const alertId = newId();

    await db.insert(t.alerts).values(minimalAlertValues({ id: alertId, orgId, ruleId }));

    const row = await db.query.alerts.findFirst({
      where: (a, { eq }) => eq(a.id, alertId),
    });

    expect(row).toBeDefined();

    // Previously Alert.parse(row) threw ZodError because nullable DB columns
    // (ackBy, resolvedAt, runbookInstanceId, etc.) failed optional validation
    expect(() => alertFromRow(row!)).not.toThrow();

    const alert = alertFromRow(row!);
    expect(alert.id).toBe(alertId);
    expect(alert.severity).toBe('critical');
    expect(alert.status).toBe('open');

    // Optional fields must be absent (undefined), not null
    expect(alert.ackBy).toBeUndefined();
    expect(alert.resolvedAt).toBeUndefined();
    expect(alert.runbookInstanceId).toBeUndefined();
    expect(alert.teamId).toBe('team_stub');
  });
});

describe('dispatchAlert', () => {
  it('runs without throwing and sets dispatched_at (no recipients → warn only)', async () => {
    const { db, redis, orgId, ruleId } = ctx;
    const alertId = newId();

    await db.insert(t.alerts).values(minimalAlertValues({ id: alertId, orgId, ruleId }));

    // No matching rule in DB → dispatch logs warn and exits gracefully
    await expect(
      dispatchAlert(db, redis, silentLog, { alertId, orgId, ruleId, ingestTs: Date.now() }),
    ).resolves.not.toThrow();
  }, TEST_TIMEOUT);

  it('sets dispatched_at after successful dispatch', async () => {
    const { db, redis, orgId, ruleId } = ctx;
    const alertId = newId();

    await db.insert(t.alerts).values(minimalAlertValues({ id: alertId, orgId, ruleId }));
    await dispatchAlert(db, redis, silentLog, { alertId, orgId, ruleId, ingestTs: Date.now() });

    const updated = await db.query.alerts.findFirst({
      where: (a, { eq }) => eq(a.id, alertId),
    });
    expect(updated!.dispatchedAt).toBeTruthy();
  }, TEST_TIMEOUT);

  it('is idempotent — second dispatchAlert call does not duplicate deliveries', async () => {
    const { db, redis, orgId, ruleId } = ctx;
    const alertId = newId();

    await db.insert(t.alerts).values(minimalAlertValues({ id: alertId, orgId, ruleId }));

    const msg = { alertId, orgId, ruleId, ingestTs: Date.now() };
    await dispatchAlert(db, redis, silentLog, msg);
    await dispatchAlert(db, redis, silentLog, msg);

    const deliveries = await db.query.deliveries.findMany({
      where: (d, { eq }) => eq(d.alertId, alertId),
    });

    // onConflictDoNothing ensures no duplicates per userId+channel
    const unique = new Set(deliveries.map((d) => `${d.userId}:${d.channel}`));
    expect(deliveries.length).toBe(unique.size);
  }, TEST_TIMEOUT);
});
