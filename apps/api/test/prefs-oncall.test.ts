import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, t } from '@alerting/db';
import { bearer, ids, login, setup, type TestCtx } from './setup.ts';

let ctx: TestCtx;
let admin: string, lead: string, member: string, outsider: string;
beforeAll(async () => {
  ctx = await setup();
  const tokens = await Promise.all(
    [ids.admin, ids.lead, ids.member, ids.outsider].map((u) => login(ctx.app, u)),
  );
  [admin, lead, member, outsider] = tokens as [string, string, string, string];
}, 180_000);
afterAll(async () => ctx?.stop());

const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: bearer(token), ...(payload && { payload }) });

describe('my preferences', () => {
  it('defaults: every severity present, UI only', async () => {
    const p = (await call('GET', '/me/preferences', member)).json();
    expect(p.channelPrefs).toHaveLength(4);
    expect(p.channelPrefs[0]).toEqual({ severity: 'critical', inHours: ['ui'], offHours: ['ui'] });
  });

  it('saves Anna-style preferences (Appendix B): critical → telegram 08–20, email outside', async () => {
    const res = await call('PUT', '/me/preferences', member, {
      timezone: 'Europe/Warsaw',
      workingHours: { days: [1, 2, 3, 4, 5, 6, 7], start: '08:00', end: '20:00' },
      channelPrefs: [
        { severity: 'critical', inHours: ['ui', 'telegram'], offHours: ['ui', 'email', 'email'] },
      ],
    });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.workingHours).toMatchObject({ start: '08:00', end: '20:00' });
    expect(p.channelPrefs[0]).toEqual({
      severity: 'critical',
      inHours: ['ui', 'telegram'],
      offHours: ['ui', 'email'],
    });
    expect(typeof p.inWorkingHoursNow).toBe('boolean');
  });

  it('rejects unknown time zones and bad hours', async () => {
    expect((await call('PUT', '/me/preferences', member, { timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect(
      (
        await call('PUT', '/me/preferences', member, {
          workingHours: { days: [1], start: '25:00', end: '20:00' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('addresses: login email is verified, other values are not; phone numbers checked', async () => {
    const own = (
      await call('PUT', '/me/addresses/email', member, { address: `${ids.member}@test.dev` })
    ).json();
    expect(own.addresses.find((a: { channel: string }) => a.channel === 'email').verified).toBe(true);
    const other = (await call('PUT', '/me/addresses/email', member, { address: 'other@test.dev' })).json();
    expect(other.addresses.find((a: { channel: string }) => a.channel === 'email').verified).toBe(false);
    expect((await call('PUT', '/me/addresses/sms', member, { address: 'call me maybe' })).statusCode).toBe(
      400,
    );
    expect((await call('PUT', '/me/addresses/telegram', member, { address: '12345' })).statusCode).toBe(400);
    expect(
      (await call('PUT', '/me/addresses/sms', member, { address: '+48 600 100 200' })).statusCode,
    ).toBe(200);
  });

  it('telegram link code: 8 unambiguous chars, one active per user', async () => {
    const a = (await call('POST', '/me/telegram/link', member)).json();
    expect(a.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(a.command).toBe(`/start ${a.code}`);
    const b = (await call('POST', '/me/telegram/link', member)).json();
    const rows = await ctx.db
      .select()
      .from(t.telegramLinkCodes)
      .where(eq(t.telegramLinkCodes.userId, ids.member));
    expect(rows.map((r) => r.code)).toEqual([b.code]);
  });
});

describe('on-call', () => {
  let id: string;
  const body = {
    teamId: ids.teamA,
    rotation: 'weekly',
    handoffTime: '09:00',
    timezone: 'Europe/Warsaw',
    participants: [ids.member, ids.lead],
    startDate: '2026-01-05',
  };

  it('lead creates a schedule for team members; outsiders of the team are rejected', async () => {
    const res = await call('POST', '/oncall/schedules', lead, body);
    expect(res.statusCode).toBe(201);
    id = res.json().id;
    expect([ids.member, ids.lead]).toContain(res.json().onCallNow.userId);
    const bad = await call('POST', '/oncall/schedules', lead, { ...body, participants: [ids.admin] });
    expect(bad.json().error.code).toBe('not_in_team');
    expect((await call('POST', '/oncall/schedules', member, body)).statusCode).toBe(403);
    expect(
      (await call('POST', '/oncall/schedules', admin, { ...body, teamId: ids.otherTeam })).statusCode,
    ).toBe(404);
  });

  it('override: members cover for themselves; covering someone else needs a lead', async () => {
    const now = Date.now();
    const window = {
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
    };
    expect(
      (await call('POST', `/oncall/schedules/${id}/overrides`, member, { userId: ids.lead, ...window }))
        .statusCode,
    ).toBe(403);
    const res = await call('POST', `/oncall/schedules/${id}/overrides`, member, {
      userId: ids.member,
      ...window,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().onCallNow).toMatchObject({ userId: ids.member });
    const reversed = await call('POST', `/oncall/schedules/${id}/overrides`, lead, {
      userId: ids.lead,
      startsAt: window.endsAt,
      endsAt: window.startsAt,
    });
    expect(reversed.statusCode).toBe(400);
  });

  it('who is on call now; other orgs see nothing', async () => {
    const now = (await call('GET', '/oncall/now', member)).json().data;
    expect(now).toEqual([
      expect.objectContaining({
        teamName: 'Team A',
        userId: ids.member,
        userName: ids.member,
        viaOverride: true,
      }),
    ]);
    expect((await call('GET', '/oncall/now', outsider)).json().data).toEqual([]);
    expect((await call('DELETE', `/oncall/schedules/${id}`, outsider)).statusCode).toBe(404);
  });

  it('lead updates and deletes', async () => {
    const upd = await call('PUT', `/oncall/schedules/${id}`, lead, {
      ...body,
      teamId: undefined,
      rotation: 'daily',
    });
    expect(upd.json().rotation).toBe('daily');
    expect((await call('DELETE', `/oncall/schedules/${id}`, lead)).statusCode).toBe(204);
  });
});
