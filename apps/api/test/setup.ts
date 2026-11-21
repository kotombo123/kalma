import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { hash } from '@node-rs/argon2';
import { Redis } from '@alerting/config';
import { createDb, runMigrations, t, type Db } from '@alerting/db';
import { buildApp } from '../src/app.ts';
import { memoryMailer } from '../src/lib/mailer.ts';
import type { AppConfig } from '../src/deps.ts';

export const ids = {
  org: 'org_test',
  otherOrg: 'org_other',
  admin: 'u_admin',
  lead: 'u_lead',
  member: 'u_member',
  outsider: 'u_outsider',
  teamA: 'team_a',
  teamB: 'team_b',
  otherTeam: 'team_other',
};
export const PASSWORD = 'secret123';
export const JWT_SECRET = 'test-secret-test-secret';

type App = Awaited<ReturnType<typeof buildApp>>;

export interface TestCtx {
  app: App;
  db: Db;
  redis: Redis;
  mailer: ReturnType<typeof memoryMailer>;
  /** Extra app instance on the same DB/Redis with other config (e.g. rate limits on). */
  makeApp: (cfg: Partial<AppConfig>) => Promise<App>;
  stop: () => Promise<void>;
}

/** Postgres + Redis in containers, migrations, and a small org with an admin, a team lead and a member. */
export async function setup(): Promise<TestCtx> {
  const [pg, rd] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const { db, sql } = createDb(pg.getConnectionUri(), 4);
  const redis = new Redis(rd.getConnectionUrl());
  await runMigrations(db);

  const passwordHash = await hash(PASSWORD);
  await db.insert(t.orgs).values([
    { id: ids.org, name: 'Test Org' },
    { id: ids.otherOrg, name: 'Other Org' },
  ]);
  await db.insert(t.users).values(
    [ids.admin, ids.lead, ids.member, ids.outsider].map((id) => ({
      id,
      email: `${id}@test.dev`,
      name: id,
      passwordHash,
    })),
  );
  await db.insert(t.memberships).values([
    { orgId: ids.org, userId: ids.admin, role: 'admin' as const },
    { orgId: ids.org, userId: ids.lead, role: 'member' as const },
    { orgId: ids.org, userId: ids.member, role: 'member' as const },
    { orgId: ids.otherOrg, userId: ids.outsider, role: 'admin' as const },
  ]);
  await db.insert(t.teams).values([
    { id: ids.teamA, orgId: ids.org, name: 'Team A' },
    { id: ids.teamB, orgId: ids.org, name: 'Team B' },
    { id: ids.otherTeam, orgId: ids.otherOrg, name: 'Other team' },
  ]);
  await db.insert(t.teamMembers).values([
    { teamId: ids.teamA, userId: ids.lead, role: 'lead' as const },
    { teamId: ids.teamA, userId: ids.member, role: 'member' as const },
  ]);

  const mailer = memoryMailer();
  const apps: App[] = [];
  const makeApp = async (cfg: Partial<AppConfig>) => {
    const a = await buildApp({
      db,
      redis,
      mailer,
      config: {
        jwtSecret: JWT_SECRET,
        publicUrl: 'http://ui.test',
        devRoutes: true,
        secureCookies: false,
        rateLimit: false,
        ingestPublicUrl: 'http://ingest.test',
        kafkaBrokers: 'kafka.test:9092',
        fileSourceRoot: '/var/log',
        ...cfg,
      },
    });
    apps.push(a);
    return a;
  };
  const app = await makeApp({});
  return {
    app,
    db,
    redis,
    mailer,
    makeApp,
    stop: async () => {
      await Promise.all(apps.map((a) => a.close()));
      await sql.end();
      redis.disconnect();
      await Promise.all([pg.stop(), rd.stop()]);
    },
  };
}

export async function loginRes(app: App, userId: string, password = PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: `${userId}@test.dev`, password },
  });
}

export async function login(app: App, userId: string) {
  const res = await loginRes(app, userId);
  if (res.statusCode !== 200) throw new Error(`login ${userId}: ${res.statusCode} ${res.body}`);
  return res.json<{ accessToken: string }>().accessToken;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'rt')?.value;
