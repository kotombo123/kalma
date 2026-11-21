import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { uiChannel } from '@alerting/config';
import { readJsonFixture } from '@alerting/contracts/fixtures';
import { t } from '@alerting/db';
import { bearer, ids, login, setup, type TestCtx } from './setup.ts';
import { WS_CLOSE } from '../src/ws/routes.ts';

let ctx: TestCtx;
let admin: string, member: string, outsider: string;
const base = readJsonFixture<Record<string, unknown>>('alert.sample.json');
const alertOf = (id: string, teamId: string) => ({ ...base, id, orgId: ids.org, teamId, groupKey: id });

beforeAll(async () => {
  ctx = await setup();
  const tokens = await Promise.all([ids.admin, ids.member, ids.outsider].map((u) => login(ctx.app, u)));
  [admin, member, outsider] = tokens as [string, string, string];
  await ctx.db
    .insert(t.alerts)
    .values({ ...alertOf('old', ids.teamB), escalationLevel: 0 } as typeof t.alerts.$inferInsert);
}, 180_000);
afterAll(async () => ctx?.stop());

type App = TestCtx['app'];
/** Connected + authenticated socket collecting every message. */
async function connect(app: App, token: string) {
  const ws: WebSocket = await app.injectWS('/ws');
  const got: { type: string; [k: string]: unknown }[] = [];
  const ready = new Promise<void>((resolve) => {
    ws.on('message', (m) => {
      const ev = JSON.parse(m.toString());
      if (ev.type === 'ready') resolve();
      else got.push(ev);
    });
  });
  ws.send(JSON.stringify({ type: 'auth', token }));
  await ready;
  return { ws, got };
}
const publish = (orgId: string, ev: object) => ctx.redis.publish(uiChannel(orgId), JSON.stringify(ev));
const settle = () => new Promise((r) => setTimeout(r, 150));
const closeCode = (ws: WebSocket) => new Promise<number>((r) => ws.on('close', (code) => r(code)));

describe('WebSocket /ws', () => {
  it('rejects bad auth with 4001', async () => {
    const ws: WebSocket = await ctx.app.injectWS('/ws');
    const code = closeCode(ws);
    ws.send(JSON.stringify({ type: 'auth', token: 'nope' }));
    expect(await code).toBe(WS_CLOSE.unauthorized);
  });

  it('two API instances both deliver; each user only gets alerts they may see', async () => {
    const second = await ctx.makeApp({});
    await second.ready(); // injectWS does not start the app the way inject() does
    const a = await connect(ctx.app, admin);
    const m = await connect(second, member);
    const o = await connect(ctx.app, outsider);

    await publish(ids.org, { type: 'alert.created', alert: alertOf('x1', ids.teamA) });
    await publish(ids.org, { type: 'alert.created', alert: alertOf('x2', ids.teamB) });
    await publish(ids.org, { type: 'alert.updated', alertId: 'x2', patch: { count: 5 } });
    await publish(ids.org, { type: 'broken' });
    await settle();

    expect(a.got.map((e) => e.type)).toEqual(['alert.created', 'alert.created', 'alert.updated']);
    expect(m.got).toHaveLength(1); // member of team A only
    expect((m.got[0] as unknown as { alert: { id: string } }).alert.id).toBe('x1');
    expect(o.got).toHaveLength(0); // other org
    for (const s of [a, m, o]) s.ws.close();
  });

  it('a delivery to the user makes that alert visible; DB lookup for unknown alerts', async () => {
    const m = await connect(ctx.app, member);
    await publish(ids.org, {
      type: 'timeline.appended',
      alertId: 'old',
      entry: { id: 'e', alertId: 'old', ts: 'now', actorType: 'system', kind: 'comment', data: {} },
    });
    await settle();
    expect(m.got).toHaveLength(0);
    await publish(ids.org, {
      type: 'delivery.updated',
      delivery: {
        id: 'd',
        alertId: 'old',
        userId: ids.member,
        channel: 'email',
        status: 'sent',
        attempts: 1,
      },
    });
    await publish(ids.org, { type: 'alert.updated', alertId: 'old', patch: { count: 2 } });
    await settle();
    expect(m.got.map((e) => e.type)).toEqual(['delivery.updated', 'alert.updated']);
    m.ws.close();
  });

  it('org-wide events (new schema) reach every member of the org', async () => {
    const m = await connect(ctx.app, member);
    const schema = {
      id: 's',
      orgId: ids.org,
      fingerprint: 'f',
      sourceId: 'src',
      status: 'new',
      fields: [],
      sample: {},
      guessedRoles: {},
      eventCount: 1,
      unmatchedCount: 0,
    };
    await publish(ids.org, { type: 'schema.discovered', schema });
    await settle();
    expect(m.got.map((e) => e.type)).toEqual(['schema.discovered']);
    m.ws.close();
  });

  it('GET /alerts?changedSince returns alerts changed after a reconnect point', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    await ctx.db.insert(t.alerts).values({
      ...alertOf('fresh', ids.teamA),
      lastSeen: new Date().toISOString(),
      escalationLevel: 0,
    } as typeof t.alerts.$inferInsert);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/alerts?changedSince=${since}`,
      headers: bearer(admin),
    });
    expect(res.json().data.map((x: { id: string }) => x.id)).toEqual(['fresh']);
  });
});

describe('GET /system/status (F-21)', () => {
  it('reports Postgres, Redis, API and the streams; needs auth', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/system/status' })).statusCode).toBe(401);
    const res = (
      await ctx.app.inject({ method: 'GET', url: '/system/status', headers: bearer(admin) })
    ).json();
    const byName = new Map(res.services.map((s: { name: string; ok: boolean }) => [s.name, s.ok]));
    expect(byName.get('Baza danych (Postgres)')).toBe(true);
    expect(byName.get('Redis')).toBe(true);
    expect(byName.get('Worker')).toBe(false); // no worker in this test
    expect(res.streams.map((s: { stream: string }) => s.stream)).toEqual(['stream:events', 'stream:alerts']);
  });
});
