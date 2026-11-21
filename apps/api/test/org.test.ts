import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_CHANGED, Redis } from '@alerting/config';
import { eq, t } from '@alerting/db';
import { sha256 } from '../src/lib/crypto.ts';
import { isInside } from '../src/org/source-config.ts';
import { bearer, ids, login, setup, type TestCtx } from './setup.ts';

let ctx: TestCtx;
let sub: Redis;
const published: { kind: string; orgId: string; id?: string }[] = [];
let admin: string, lead: string, member: string, outsider: string;

beforeAll(async () => {
  ctx = await setup();
  sub = ctx.redis.duplicate();
  await sub.subscribe(CONFIG_CHANGED);
  sub.on('message', (_c, m) => published.push(JSON.parse(m)));
  const tokens = await Promise.all(
    [ids.admin, ids.lead, ids.member, ids.outsider].map((u) => login(ctx.app, u)),
  );
  [admin, lead, member, outsider] = tokens as [string, string, string, string];
}, 180_000);
afterAll(async () => {
  sub?.disconnect();
  await ctx?.stop();
});

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  token: string,
  payload?: object,
) => ctx.app.inject({ method, url, headers: bearer(token), ...(payload && { payload }) });
const waitFor = async (pred: () => boolean) => {
  for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 20));
  return pred();
};

describe('teams', () => {
  let teamId: string;

  it('admin creates a team (201 + Location); members cannot', async () => {
    const res = await call('POST', '/teams', admin, {
      name: 'Ops',
      teamsWebhookUrl: 'https://example.test/hook',
    });
    expect(res.statusCode).toBe(201);
    teamId = res.json().id;
    expect(res.headers.location).toBe(`/teams/${teamId}`);
    expect(await waitFor(() => published.some((p) => p.kind === 'teams' && p.id === teamId))).toBe(true);
    expect((await call('POST', '/teams', member, { name: 'X' })).statusCode).toBe(403);
    expect((await call('POST', '/teams', lead, { name: 'X' })).statusCode).toBe(403);
  });

  it('rejects non-HTTPS Teams webhooks', async () => {
    const res = await call('POST', '/teams', admin, {
      name: 'Bad',
      teamsWebhookUrl: 'http://169.254.169.254/x',
    });
    expect(res.statusCode).toBe(400);
  });

  it('Teams webhook URL is visible to admins and team leads only', async () => {
    await call('PATCH', `/teams/${ids.teamA}`, admin, {
      teamsWebhookUrl: 'https://example.test/secret-hook',
    });
    const asMember = (await call('GET', `/teams/${ids.teamA}`, member)).json();
    expect(asMember).toMatchObject({ teamsWebhookUrl: null, teamsWebhookConfigured: true });
    expect((await call('GET', `/teams/${ids.teamA}`, lead)).json().teamsWebhookUrl).toBe(
      'https://example.test/secret-hook',
    );
  });

  it('lists teams with member counts; any org member can read; other orgs get 404', async () => {
    const list = (await call('GET', '/teams', member)).json();
    expect(list.data.find((x: { id: string }) => x.id === ids.teamA).memberCount).toBe(2);
    expect((await call('GET', `/teams/${ids.teamA}`, member)).json().members).toHaveLength(2);
    expect((await call('GET', `/teams/${ids.teamA}`, outsider)).statusCode).toBe(404);
  });

  it('team lead edits only their own team', async () => {
    expect((await call('PATCH', `/teams/${ids.teamA}`, lead, { name: 'Team A+' })).json().name).toBe(
      'Team A+',
    );
    expect((await call('PATCH', `/teams/${ids.teamB}`, lead, { name: 'Nope' })).statusCode).toBe(403);
    expect((await call('PATCH', `/teams/${ids.teamA}`, member, { name: 'Nope' })).statusCode).toBe(403);
  });

  it('lead adds a member; only admins appoint or touch leads', async () => {
    expect(
      (await call('PUT', `/teams/${ids.teamA}/members/${ids.admin}`, lead, { role: 'member' })).statusCode,
    ).toBe(200);
    expect(
      (await call('PUT', `/teams/${ids.teamA}/members/${ids.member}`, lead, { role: 'lead' })).statusCode,
    ).toBe(403);
    expect((await call('DELETE', `/teams/${ids.teamA}/members/${ids.lead}`, lead)).statusCode).toBe(403);
    expect(
      (await call('PUT', `/teams/${ids.teamA}/members/${ids.outsider}`, lead, { role: 'member' })).statusCode,
    ).toBe(404);
    expect(
      (await call('PUT', `/teams/${teamId}/members/${ids.member}`, admin, { role: 'lead' })).statusCode,
    ).toBe(200);
    expect((await call('DELETE', `/teams/${ids.teamA}/members/${ids.admin}`, lead)).statusCode).toBe(204);
  });

  it('team with rules cannot be deleted (409); empty team can (204)', async () => {
    await ctx.db.insert(t.runbooks).values({
      id: 'rb_x',
      orgId: ids.org,
      teamId: ids.teamB,
      name: 'x',
      format: 'text',
      source: 'x',
    });
    expect((await call('DELETE', `/teams/${ids.teamB}`, admin)).json().error.code).toBe('team_in_use');
    expect((await call('DELETE', `/teams/${teamId}`, lead)).statusCode).toBe(403);
    expect((await call('DELETE', `/teams/${teamId}`, admin)).statusCode).toBe(204);
  });
});

describe('org members', () => {
  it('lists members; admin changes roles; the last admin is protected', async () => {
    const list = (await call('GET', '/members', member)).json();
    expect(list.data.map((m: { id: string }) => m.id)).toEqual(
      expect.arrayContaining([ids.admin, ids.member]),
    );
    expect((await call('PATCH', `/members/${ids.member}`, member, { role: 'admin' })).statusCode).toBe(403);
    expect((await call('PATCH', `/members/${ids.admin}`, admin, { role: 'member' })).json().error.code).toBe(
      'last_admin',
    );
    expect((await call('DELETE', `/members/${ids.admin}`, admin)).statusCode).toBe(409);
    expect((await call('PATCH', `/members/${ids.outsider}`, admin, { role: 'admin' })).statusCode).toBe(404);
  });

  it('removing a member also removes them from the org’s teams', async () => {
    await ctx.db
      .insert(t.users)
      .values({ id: 'u_tmp', email: 'tmp@test.dev', name: 'tmp', passwordHash: 'x' });
    await ctx.db.insert(t.memberships).values({ orgId: ids.org, userId: 'u_tmp', role: 'member' });
    await ctx.db.insert(t.teamMembers).values({ teamId: ids.teamA, userId: 'u_tmp', role: 'member' });
    expect((await call('DELETE', '/members/u_tmp', admin)).statusCode).toBe(204);
    expect(await ctx.db.select().from(t.teamMembers).where(eq(t.teamMembers.userId, 'u_tmp'))).toEqual([]);
  });
});

describe('systems and sources', () => {
  let systemId: string;
  let sourceId: string;
  let firstKey: string;

  it('admin creates a system; members only read', async () => {
    const res = await call('POST', '/systems', admin, { name: 'Payments', description: 'payments-api' });
    expect(res.statusCode).toBe(201);
    systemId = res.json().id;
    expect((await call('POST', '/systems', member, { name: 'X' })).statusCode).toBe(403);
    expect((await call('GET', `/systems/${systemId}`, member)).json().name).toBe('Payments');
    expect((await call('GET', `/systems/${systemId}`, outsider)).statusCode).toBe(404);
  });

  it('creating an HTTP source returns the API key once, with connect instructions', async () => {
    const res = await call('POST', '/sources', admin, {
      systemId,
      name: 'Alertmanager',
      config: { transport: 'http' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    sourceId = body.source.id;
    firstKey = body.apiKey;
    expect(firstKey).toMatch(/^ak_[A-Za-z0-9_-]{43}$/);
    expect(body.source.apiKeyPrefix).toBe(firstKey.slice(0, 12));
    expect(body.connect).toMatchObject({
      url: `http://ingest.test/ingest/${sourceId}`,
      headers: { 'X-Api-Key': firstKey },
    });
    expect(res.body).not.toContain('apiKeyHash');
    const [row] = await ctx.db.select().from(t.sources).where(eq(t.sources.id, sourceId));
    expect(row?.apiKeyHash).toBe(sha256(firstKey));
    expect(await waitFor(() => published.some((p) => p.kind === 'sources' && p.id === sourceId))).toBe(true);
  });

  it('sources report activity from their schemas', async () => {
    await ctx.db.insert(t.schemas).values([
      {
        id: 'sa1',
        orgId: ids.org,
        sourceId,
        fingerprint: 'fa1',
        eventCount: 5,
        lastSeen: '2026-10-23T09:00:00Z',
      },
      {
        id: 'sa2',
        orgId: ids.org,
        sourceId,
        fingerprint: 'fa2',
        eventCount: 2,
        lastSeen: '2026-10-23T10:00:00Z',
      },
    ]);
    const res = (await call('GET', `/sources/${sourceId}`, member)).json();
    expect(res).toMatchObject({ eventCount: 7 });
    expect(new Date(res.lastEventAt).toISOString()).toBe('2026-10-23T10:00:00.000Z');
    await ctx.db.delete(t.schemas).where(eq(t.schemas.sourceId, sourceId));
  });

  it('reading a source never shows the key', async () => {
    const res = await call('GET', `/sources/${sourceId}`, member);
    expect(res.json().connect.headers['X-Api-Key']).toBe('<API_KEY>');
    expect(res.body).not.toContain(firstKey);
    const list = await call('GET', `/sources?systemId=${systemId}`, member);
    expect(list.json().data).toHaveLength(1);
    expect(list.body).not.toContain('apiKeyHash');
  });

  it('rotating the key replaces the stored hash', async () => {
    const res = await call('POST', `/sources/${sourceId}/rotate-key`, admin);
    const newKey = res.json().apiKey;
    expect(newKey).not.toBe(firstKey);
    const [row] = await ctx.db.select().from(t.sources).where(eq(t.sources.id, sourceId));
    expect(row?.apiKeyHash).toBe(sha256(newKey));
    expect((await call('POST', `/sources/${sourceId}/rotate-key`, member)).statusCode).toBe(403);
  });

  it('validates file paths, poll URLs, regexes and transport changes', async () => {
    const bad = [
      { config: { transport: 'file', path: '/var/log/../../etc/passwd' } },
      { config: { transport: 'file', path: 'relative.log' } },
      { config: { transport: 'poll', url: 'file:///etc/passwd' } },
      { config: { transport: 'kafka', topic: 'bad topic!' } },
      { config: { transport: 'http' }, parserOptions: { regex: '(' } },
    ];
    for (const b of bad) {
      expect((await call('POST', '/sources', admin, { systemId, name: 'x', ...b })).statusCode).toBe(400);
    }
    const ok = await call('POST', '/sources', admin, {
      systemId,
      name: 'log',
      config: { transport: 'file', path: '/var/log/demo/app.log' },
      format: 'regex',
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().connect.path).toBe('/var/log/demo/app.log');
    const change = await call('PATCH', `/sources/${sourceId}`, admin, {
      config: { transport: 'kafka', topic: 't' },
    });
    expect(change.json().error.code).toBe('transport_change');
    expect((await call('PATCH', `/sources/${sourceId}`, admin, { enabled: false })).json().enabled).toBe(
      false,
    );
  });

  it('poll header values are write-only (masked for everyone, kept when sent back masked)', async () => {
    const created = await call('POST', '/sources', admin, {
      systemId,
      name: 'poller',
      config: { transport: 'poll', url: 'https://mon.test/api', headers: { Authorization: 'Bearer s3cr3t' } },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().source.id;
    for (const tok of [admin, member]) {
      const res = await call('GET', `/sources/${id}`, tok);
      expect(res.json().config.headers).toEqual({ Authorization: '***' });
      expect(res.body).not.toContain('s3cr3t');
      expect((await call('GET', '/sources', tok)).body).not.toContain('s3cr3t');
    }
    const patched = await call('PATCH', `/sources/${id}`, admin, {
      config: {
        transport: 'poll',
        url: 'https://mon.test/v2',
        headers: { Authorization: '***', 'X-Extra': 'x' },
      },
    });
    expect(patched.body).not.toContain('s3cr3t');
    const [row] = await ctx.db.select().from(t.sources).where(eq(t.sources.id, id));
    expect(row?.config).toMatchObject({
      url: 'https://mon.test/v2',
      headers: { Authorization: 'Bearer s3cr3t', 'X-Extra': 'x' },
    });
  });

  it('cannot attach a source to another org’s system; other orgs cannot see sources', async () => {
    await ctx.db.insert(t.systems).values({ id: 'sys_other', orgId: ids.otherOrg, name: 'Other' });
    const res = await call('POST', '/sources', admin, {
      systemId: 'sys_other',
      name: 'x',
      config: { transport: 'http' },
    });
    expect(res.statusCode).toBe(404);
    expect((await call('GET', `/sources/${sourceId}`, outsider)).statusCode).toBe(404);
    // outsider is admin of their own org: the source is simply not found there
    expect((await call('DELETE', `/sources/${sourceId}`, outsider)).statusCode).toBe(404);
  });

  it('system with sources cannot be deleted; after deleting sources it can', async () => {
    expect((await call('DELETE', `/systems/${systemId}`, admin)).json().error.code).toBe('system_in_use');
    const all = (await call('GET', `/sources?systemId=${systemId}`, admin)).json().data as { id: string }[];
    for (const s of all) expect((await call('DELETE', `/sources/${s.id}`, admin)).statusCode).toBe(204);
    expect((await call('DELETE', `/systems/${systemId}`, admin)).statusCode).toBe(204);
  });
});

describe('isInside', () => {
  it('blocks traversal and prefix tricks', () => {
    expect(isInside('/var/log', '/var/log/a.log')).toBe(true);
    expect(isInside('/var/log', '/var/log/../etc/passwd')).toBe(false);
    expect(isInside('/var/log', '/var/logs/a.log')).toBe(false);
    expect(isInside('/var/log', 'var/log/a.log')).toBe(false);
  });
});
