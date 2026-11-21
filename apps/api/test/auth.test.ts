import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  cookieOf,
  ids,
  JWT_SECRET,
  login,
  loginRes,
  PASSWORD,
  setup,
  type TestCtx,
} from './setup.ts';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await setup();
}, 180_000);
afterAll(async () => ctx?.stop());

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('register and login', () => {
  it('register creates an org with the creator as admin (201)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'Founder@New.dev', password: 'pass12345', name: 'Founder', orgName: 'New Co' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      role: 'admin',
      org: { name: 'New Co' },
      user: { email: 'founder@new.dev' },
    });
    const cookie = res.cookies.find((c) => c.name === 'rt')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
  });

  it('register rejects duplicates (409) and weak passwords (400)', async () => {
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'founder@new.dev', password: 'pass12345', name: 'X', orgName: 'Y' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('email_taken');
    const weak = await ctx.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'w@new.dev', password: 'short', name: 'X', orgName: 'Y' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toMatchObject({
      code: 'validation',
      issues: [{ path: ['body', 'password'], message: expect.any(String) }],
    });
  });

  it('login gives the same generic error for unknown email and wrong password', async () => {
    const wrong = await loginRes(ctx.app, ids.admin, 'nope');
    const unknown = await loginRes(ctx.app, 'nobody', 'nope');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('unknown routes use the same error shape', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Route not found' } });
  });
});

describe('tokens', () => {
  it('/me needs a valid access token and returns role + teams', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    const token = await login(ctx.app, ids.lead);
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(token) })).json();
    expect(me).toMatchObject({ role: 'member', org: { id: ids.org } });
    expect(me.teams).toEqual([{ id: ids.teamA, name: 'Team A', role: 'lead' }]);
  });

  it('rejects alg "none" and tokens signed with another secret', async () => {
    const claims = { sub: ids.admin, orgId: ids.org, role: 'admin', exp: Math.floor(Date.now() / 1000) + 60 };
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
    const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
    const forged = `${head}.${createHmac('sha256', 'other-secret').update(head).digest('base64url')}`;
    const valid = `${head}.${createHmac('sha256', JWT_SECRET).update(head).digest('base64url')}`;
    for (const tok of [none, forged]) {
      expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(tok) })).statusCode).toBe(
        401,
      );
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(valid) })).statusCode).toBe(
      200,
    );
  });

  it('refresh rotates the token; reusing an old one revokes the whole family', async () => {
    const rt1 = cookieOf(await loginRes(ctx.app, ids.member))!;
    const r1 = await ctx.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { rt: rt1 } });
    expect(r1.statusCode).toBe(200);
    const rt2 = cookieOf(r1)!;
    expect(rt2).not.toBe(rt1);

    // rt1 replayed (stolen) → rejected, and rt2 dies with it
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { rt: rt1 } })).statusCode,
    ).toBe(401);
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { rt: rt2 } })).statusCode,
    ).toBe(401);
  });

  it('refresh token is not accepted as an access token, and missing cookie → 401', async () => {
    const rt = cookieOf(await loginRes(ctx.app, ids.member))!;
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(rt) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/refresh' })).statusCode).toBe(401);
  });

  it('logout revokes the refresh token (204)', async () => {
    const rt = cookieOf(await loginRes(ctx.app, ids.member))!;
    const out = await ctx.app.inject({ method: 'POST', url: '/auth/logout', cookies: { rt } });
    expect(out.statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/refresh', cookies: { rt } })).statusCode).toBe(
      401,
    );
  });

  it('rate-limits login per IP (429 + Retry-After)', async () => {
    const limited = await ctx.makeApp({ rateLimit: true });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await limited.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'x@test.dev', password: 'x' },
        remoteAddress: '10.9.9.9',
      });
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.headers['retry-after']).toBeDefined();
        expect(res.json().error.code).toBe('rate_limited');
      }
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('dev login-as works only when dev routes are on', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/dev/login-as',
      payload: { email: `${ids.member}@test.dev` },
    });
    expect(res.json().user.id).toBe(ids.member);
    const prod = await ctx.makeApp({ devRoutes: false });
    expect(
      (
        await prod.inject({
          method: 'POST',
          url: '/dev/login-as',
          payload: { email: `${ids.member}@test.dev` },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('invite permissions (3 roles)', () => {
  const invite = async (token: string, payload: object) =>
    ctx.app.inject({ method: 'POST', url: '/invites', headers: bearer(token), payload });

  it('org admin: any role, any team; list is paginated', async () => {
    const admin = await login(ctx.app, ids.admin);
    const res = await invite(admin, { email: 'newlead@test.dev', teamId: ids.teamB, teamRole: 'lead' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      emailed: true,
      link: expect.stringMatching(/^http:\/\/ui\.test\/invite\//),
    });
    expect(ctx.mailer.sent.at(-1)?.to).toBe('newlead@test.dev');
    expect((await invite(admin, { email: 'admin2@test.dev', role: 'admin' })).statusCode).toBe(201);

    const p1 = (
      await ctx.app.inject({ method: 'GET', url: '/invites?limit=1', headers: bearer(admin) })
    ).json();
    expect(p1.data).toHaveLength(1);
    expect(p1.nextCursor).toBeTypeOf('string');
    const p2 = (
      await ctx.app.inject({
        method: 'GET',
        url: `/invites?limit=1&cursor=${p1.nextCursor}`,
        headers: bearer(admin),
      })
    ).json();
    expect(p2.data[0].id).not.toBe(p1.data[0].id);
  });

  it('team lead: only members, only into their own team; cannot list', async () => {
    const lead = await login(ctx.app, ids.lead);
    expect((await invite(lead, { email: 'm2@test.dev', teamId: ids.teamA })).statusCode).toBe(201);
    expect((await invite(lead, { email: 'm3@test.dev', teamId: ids.teamB })).statusCode).toBe(403);
    expect(
      (await invite(lead, { email: 'm4@test.dev', teamId: ids.teamA, teamRole: 'lead' })).statusCode,
    ).toBe(403);
    expect((await invite(lead, { email: 'm5@test.dev', teamId: ids.teamA, role: 'admin' })).statusCode).toBe(
      403,
    );
    expect((await invite(lead, { email: 'm6@test.dev' })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/invites', headers: bearer(lead) })).statusCode).toBe(
      403,
    );
  });

  it('member: cannot invite', async () => {
    const member = await login(ctx.app, ids.member);
    const res = await invite(member, { email: 'x@test.dev', teamId: ids.teamA });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('nobody can invite into another org’s team (404, no existence leak)', async () => {
    const admin = await login(ctx.app, ids.admin);
    expect((await invite(admin, { email: 'x@test.dev', teamId: ids.otherTeam })).statusCode).toBe(404);
  });

  it('org name is HTML-escaped in the email', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: 'evil@x.dev',
        password: 'pass12345',
        name: 'E',
        orgName: '<img src=x onerror=alert(1)>',
      },
    });
    await invite(res.json().accessToken, { email: 'victim@x.dev' });
    expect(ctx.mailer.sent.at(-1)?.html).toContain('&lt;img');
    expect(ctx.mailer.sent.at(-1)?.html).not.toContain('<img');
  });
});

describe('accepting an invite', () => {
  const createInvite = async (payload: object) => {
    const admin = await login(ctx.app, ids.admin);
    const { link } = (
      await ctx.app.inject({ method: 'POST', url: '/invites', headers: bearer(admin), payload })
    ).json<{ link: string }>();
    return link.split('/invite/')[1]!;
  };
  const accept = (token: string, payload: object) =>
    ctx.app.inject({ method: 'POST', url: `/invites/${token}/accept`, payload });

  it('new user: account created, joins org + team; token works once (410 after)', async () => {
    const token = await createInvite({ email: 'joiner@test.dev', teamId: ids.teamB, teamRole: 'lead' });
    const info = (await ctx.app.inject({ method: 'GET', url: `/invites/${token}` })).json();
    expect(info).toMatchObject({
      email: 'joiner@test.dev',
      orgName: 'Test Org',
      teamName: 'Team B',
      userExists: false,
    });

    expect((await accept(token, { password: 'pass12345' })).json().error.code).toBe('name_required');
    expect((await accept(token, { name: 'J', password: 'short' })).json().error.code).toBe('weak_password');

    const ok = await accept(token, { name: 'Joiner', password: 'pass12345' });
    expect(ok.statusCode).toBe(200);
    const me = (
      await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(ok.json().accessToken) })
    ).json();
    expect(me.teams).toEqual([{ id: ids.teamB, name: 'Team B', role: 'lead' }]);

    const again = await accept(token, { name: 'Joiner', password: 'pass12345' });
    expect(again.statusCode).toBe(410);
  });

  it('two concurrent accepts: exactly one wins', async () => {
    const token = await createInvite({ email: 'race@test.dev' });
    const res = await Promise.all([1, 2].map(() => accept(token, { name: 'Race', password: 'pass12345' })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 410]);
  });

  it('existing user from another org joins with their own password', async () => {
    const token = await createInvite({ email: `${ids.outsider}@test.dev` });
    expect((await accept(token, { password: 'wrong-pass' })).statusCode).toBe(401);
    const ok = await accept(token, { password: PASSWORD });
    expect(ok.json().org.id).toBe(ids.org);
    const me = (
      await ctx.app.inject({ method: 'GET', url: '/me', headers: bearer(ok.json().accessToken) })
    ).json();
    expect(me.orgs.map((o: { id: string }) => o.id).sort()).toEqual([ids.otherOrg, ids.org].sort());
  });

  it('unknown token → 404', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: `/invites/${'x'.repeat(43)}` })).statusCode).toBe(404);
  });
});

describe('OpenAPI (F-10)', () => {
  it('serves the spec with every route group and a Swagger UI', async () => {
    const spec = (await ctx.app.inject({ method: 'GET', url: '/docs/json' })).json();
    expect(spec.openapi).toMatch(/^3\./);
    const paths = Object.keys(spec.paths);
    for (const p of [
      '/auth/login',
      '/alerts',
      '/rules/preview',
      '/schemas/{schemaId}/mapping',
      '/runbooks/parse',
      '/oncall/now',
    ]) {
      expect(paths).toContain(p);
    }
    expect(spec.paths['/auth/login'].post.requestBody).toBeDefined();
    const ui = await ctx.app.inject({ method: 'GET', url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
  });

  it('JSON API responses keep a strict CSP', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
  });
});
