import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_CHANGED, Redis, RULES_SYNC_LEASE } from '@alerting/config';
import { SEED, type Rule } from '@alerting/contracts';
import { readFixture } from '@alerting/contracts/fixtures';
import { createDb, eq, runMigrations, t, type Db } from '@alerting/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RulesSync, RulesWatcher } from '../src/rules-sync.ts';

const hasDocker =
  !!process.env.CI ||
  !!process.env.DOCKER_HOST ||
  ['/var/run/docker.sock', `${homedir()}/.docker/run/docker.sock`].some((p) => existsSync(p));

const PRICING = readFixture('rules/team-pricing.yaml');
const FILE_PATH = 'config/rules/team-pricing.yaml';

describe.skipIf(!hasDocker)('B1-15 rules sync against Postgres + Redis', { timeout: 60_000 }, () => {
  let pg: StartedPostgreSqlContainer;
  let rd: StartedRedisContainer;
  let db: Db;
  let redis: Redis;
  let sub: Redis;
  let end: () => Promise<void>;
  let dir: string;
  let sync: RulesSync;
  const published: { id?: string; version?: number }[] = [];

  beforeAll(async () => {
    [pg, rd] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
    const conn = createDb(pg.getConnectionUri(), 4);
    db = conn.db;
    redis = new Redis(rd.getConnectionUrl());
    sub = new Redis(rd.getConnectionUrl());
    await sub.subscribe(CONFIG_CHANGED);
    sub.on('message', (_c, m) => published.push(JSON.parse(m)));
    await runMigrations(db);
    await db.insert(t.orgs).values({ id: SEED.orgId, name: 'Kalma' });
    await db.insert(t.teams).values([
      { id: SEED.teams.pricing, orgId: SEED.orgId, name: 'Pricing' },
      { id: SEED.teams.settlements, orgId: SEED.orgId, name: 'Settlements' },
    ]);
    await db.insert(t.runbooks).values({
      id: SEED.runbooks.pricingLatency,
      orgId: SEED.orgId,
      teamId: SEED.teams.pricing,
      name: 'pricing-latency',
      format: 'text',
      source: 'Check the quote feed.',
    });
    end = async () => {
      await Promise.all([conn.sql.end(), redis.quit(), sub.quit()]);
      await Promise.all([pg.stop(), rd.stop()]);
    };
  }, 120_000);
  afterAll(() => end?.());

  beforeEach(async () => {
    await db.delete(t.rules);
    dir = await mkdtemp(join(tmpdir(), 'rules-'));
    sync = new RulesSync(db, redis, dir);
    published.length = 0;
  });

  const row = async () => {
    const [r] = await db.select().from(t.rules).where(eq(t.rules.filePath, FILE_PATH));
    return r!;
  };
  const versions = async (id: string) =>
    (await db.select().from(t.ruleVersions).where(eq(t.ruleVersions.ruleId, id))).length;

  it('creates, skips unchanged, versions an edit and publishes config:changed', async () => {
    await writeFile(join(dir, 'team-pricing.yaml'), PRICING);
    const [created] = await sync.syncAll();
    expect(created).toMatchObject({ result: 'created', version: 1 });
    const r1 = await row();
    expect(r1).toMatchObject({ origin: 'file', teamId: SEED.teams.pricing, version: 1, fileError: null });
    expect((r1.definition as Rule).runbookId).toBe(SEED.runbooks.pricingLatency);
    expect((r1.definition as Rule).routing.targets).toEqual([{ type: 'team', teamId: SEED.teams.pricing }]);

    expect((await sync.syncAll())[0]).toMatchObject({ result: 'unchanged' });

    await writeFile(
      join(dir, 'team-pricing.yaml'),
      PRICING.replace('dedup: { windowSec: 300 }', 'dedup: { windowSec: 60 }'),
    );
    expect(await sync.syncFile('team-pricing.yaml')).toMatchObject({ result: 'updated', version: 2 });
    const r2 = await row();
    expect((r2.definition as Rule).dedup.windowSec).toBe(60);
    expect(await versions(r2.id)).toBe(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(published).toEqual([
      expect.objectContaining({ id: r1.id, version: 1 }),
      expect.objectContaining({ id: r1.id, version: 2 }),
    ]);
  });

  it('an invalid file keeps the last good version and sets file_error until fixed', async () => {
    await writeFile(join(dir, 'team-pricing.yaml'), PRICING);
    await sync.syncAll();

    await writeFile(join(dir, 'team-pricing.yaml'), PRICING.replace('team: pricing', 'team: nobody'));
    expect(await sync.syncFile('team-pricing.yaml')).toMatchObject({ result: 'invalid' });
    let r = await row();
    expect(r.fileError).toContain('unknown team "nobody"');
    expect(r).toMatchObject({ version: 1, teamId: SEED.teams.pricing, enabled: true });

    await writeFile(join(dir, 'team-pricing.yaml'), `${PRICING}\n  oops: [`);
    await sync.syncFile('team-pricing.yaml');
    expect((await row()).fileError).toMatch(/^YAML: /);

    await writeFile(
      join(dir, 'team-pricing.yaml'),
      PRICING.replace('{{service}}: {{instrument', '{{#if service}: {{instrument'),
    );
    await sync.syncFile('team-pricing.yaml');
    expect((await row()).fileError).toContain('presentation.titleTemplate');

    await writeFile(join(dir, 'team-pricing.yaml'), PRICING);
    expect(await sync.syncFile('team-pricing.yaml')).toMatchObject({ result: 'updated', version: 1 });
    r = await row();
    expect(r.fileError).toBeNull();
    expect(await versions(r.id)).toBe(1);
  });

  it('a removed file disables its rule', async () => {
    await writeFile(join(dir, 'team-pricing.yaml'), PRICING);
    await writeFile(join(dir, 'other.yaml'), PRICING.replace('name: Pricing engine warnings', 'name: Other'));
    await sync.syncAll();
    await unlink(join(dir, 'team-pricing.yaml'));
    expect(await sync.syncAll()).toContainEqual(expect.objectContaining({ result: 'removed' }));
    expect(await row()).toMatchObject({ enabled: false, fileError: 'The file was removed' });
  });

  it('a missing or emptied directory disables nothing', async () => {
    await writeFile(join(dir, 'team-pricing.yaml'), PRICING);
    await writeFile(join(dir, 'other.yaml'), PRICING.replace('name: Pricing engine warnings', 'name: Other'));
    await sync.syncAll();

    // Emptied (a git checkout of a branch without config/rules), then gone (volume not mounted).
    await unlink(join(dir, 'team-pricing.yaml'));
    await unlink(join(dir, 'other.yaml'));
    expect(await sync.syncFile('team-pricing.yaml')).toMatchObject({ result: 'ignored' });
    await rm(dir, { recursive: true, force: true });
    expect(await sync.syncAll()).toEqual([]);
    const rows = await db.select().from(t.rules);
    expect(rows.map((r) => r.enabled)).toEqual([true, true]);
  });

  it('only the lease holder watches; an edit lands in the database in well under 2 s', async () => {
    await redis.del(RULES_SYNC_LEASE);
    await writeFile(join(dir, 'team-pricing.yaml'), PRICING);
    const a = new RulesWatcher(sync, redis, dir, { owner: 'a', debounceMs: 50 });
    const b = new RulesWatcher(new RulesSync(db, redis, dir), redis, dir, { owner: 'b', debounceMs: 50 });
    await a.tick();
    await b.tick();
    expect(a.isHolder).toBe(true);
    expect(b.isHolder).toBe(false);

    // The first tick queues a full scan.
    for (let i = 0; i < 50 && !(await db.select().from(t.rules)).length; i++)
      await new Promise((r) => setTimeout(r, 20));
    const before = await row();

    const t0 = Date.now();
    const text = await readFile(join(dir, 'team-pricing.yaml'), 'utf8');
    await writeFile(
      join(dir, 'team-pricing.yaml'),
      text.replace('windowSec: 300 }\ngrouping', 'windowSec: 120 }\ngrouping'),
    );
    let after = before;
    while (after.version === before.version && Date.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 20));
      after = await row();
    }
    expect(after.version).toBe(before.version + 1);
    expect((after.definition as Rule).dedup.windowSec).toBe(120);
    expect(Date.now() - t0).toBeLessThan(2000);

    await a.stop();
    await b.tick(); // lease released: b takes over
    expect(b.isHolder).toBe(true);
    await b.stop();
    await rm(dir, { recursive: true, force: true });
  });
});
