import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dedupKey, Redis, uiChannel } from '@alerting/config';
import { UiEvent } from '@alerting/contracts';
import { readJsonFixture } from '@alerting/contracts/fixtures';
import { eq, t } from '@alerting/db';
import { sha256 } from '../src/lib/crypto.ts';
import { bearer, ids, login, setup, type TestCtx } from './setup.ts';

let ctx: TestCtx;
let sub: Redis;
const ui: UiEvent[] = [];
let admin: string, lead: string, member: string, outsider: string;
const TOKEN = 'x'.repeat(40);

const base = readJsonFixture<Record<string, unknown>>('alert.sample.json');
const alertRow = (id: string, teamId: string, over: Record<string, unknown> = {}) =>
  ({
    ...base,
    id,
    orgId: ids.org,
    teamId,
    groupKey: `g-${id}`,
    escalationLevel: 0,
    ...over,
  }) as typeof t.alerts.$inferInsert;

beforeAll(async () => {
  ctx = await setup();
  sub = ctx.redis.duplicate();
  await sub.subscribe(uiChannel(ids.org));
  // only contract-valid events count (the WebSocket drops the rest)
  sub.on('message', (_c, m) => {
    const ev = UiEvent.safeParse(JSON.parse(m));
    if (ev.success) ui.push(ev.data);
  });
  const tokens = await Promise.all(
    [ids.admin, ids.lead, ids.member, ids.outsider].map((u) => login(ctx.app, u)),
  );
  [admin, lead, member, outsider] = tokens as [string, string, string, string];

  await ctx.db
    .insert(t.alerts)
    .values([
      alertRow('a1', ids.teamA, { title: 'order-settlement failed at validate-counterparty' }),
      alertRow('a2', ids.teamB, { title: '100% CPU on pricing', severity: 'warning' }),
      alertRow('a3', ids.teamB, { title: 'notified me', severity: 'info' }),
      alertRow('a4', ids.teamB, { title: 'hidden from member', status: 'resolved' }),
    ]);
  await ctx.db.insert(t.deliveries).values({
    id: 'd1',
    alertId: 'a3',
    userId: ids.member,
    channel: 'email',
    address: 'secret-address@test.dev',
    status: 'sent',
  });
  await ctx.db.insert(t.runbookInstances).values({
    id: 'ri1',
    alertId: 'a1',
    runbookId: 'rb',
    runbookVersion: 1,
    steps: [
      {
        id: 's1',
        kind: 'manual',
        text: 'Check dashboard',
        approval: 'none',
        state: 'pending',
        missing: [],
        attempts: 0,
      },
      {
        id: 's2',
        kind: 'action',
        text: 'Escalate',
        approval: 'required',
        state: 'waiting_approval',
        missing: [],
        attempts: 0,
      },
    ],
  });
  await ctx.db.insert(t.approvals).values([
    {
      id: 'ap1',
      alertId: 'a1',
      stepId: 's2',
      code: '7f3k',
      tokenHash: sha256('other-token-other-token-other-token-x'),
    },
    { id: 'ap2', alertId: 'a1', stepId: 's2', code: '9z9z', tokenHash: sha256(TOKEN) },
    { id: 'ap_b', alertId: 'a2', stepId: 's9', code: 'bbbb', tokenHash: sha256('b'.repeat(40)) },
  ]);
}, 180_000);
afterAll(async () => {
  sub?.disconnect();
  await ctx?.stop();
});

const call = (method: 'GET' | 'POST', url: string, token: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: bearer(token), ...(payload && { payload }) });
const idsOf = (res: { json: () => { data: { id: string }[] } }) =>
  res
    .json()
    .data.map((a) => a.id)
    .sort();

describe('visibility', () => {
  it('admin sees all; member sees own team + alerts they were notified about; other orgs nothing', async () => {
    expect(idsOf(await call('GET', '/alerts', admin))).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(idsOf(await call('GET', '/alerts', member))).toEqual(['a1', 'a3']);
    expect(idsOf(await call('GET', '/alerts', outsider))).toEqual([]);
    expect((await call('GET', '/alerts/a2', member)).statusCode).toBe(404);
    expect((await call('POST', '/alerts/a2/ack', member)).statusCode).toBe(404);
    expect((await call('GET', '/alerts/a1', outsider)).statusCode).toBe(404);
  });

  it('filters by status, severity and text (wildcards in text are literal)', async () => {
    expect(idsOf(await call('GET', '/alerts?status=resolved', admin))).toEqual(['a4']);
    expect(idsOf(await call('GET', '/alerts?severity=warning,info', admin))).toEqual(['a2', 'a3']);
    expect(idsOf(await call('GET', '/alerts?q=100%25', admin))).toEqual(['a2']);
    expect(idsOf(await call('GET', '/alerts?q=%25', admin))).toEqual(['a2']);
    expect((await call('GET', '/alerts?status=bogus', admin)).statusCode).toBe(400);
  });

  it('detail has runbook, approvals and deliveries without other people’s addresses', async () => {
    const res = await call('GET', '/alerts/a3', member);
    expect(res.json().deliveries[0]).toMatchObject({
      channel: 'email',
      status: 'sent',
      userName: ids.member,
    });
    expect(res.body).not.toContain('secret-address');
    const a1 = (await call('GET', '/alerts/a1', member)).json();
    expect(a1.runbook.steps).toHaveLength(2);
    expect(a1.approvals.map((a: { id: string }) => a.id)).toEqual(['ap1', 'ap2']);
    expect(a1.alert.title).toContain('order-settlement');
  });
});

describe('actions', () => {
  it('ACK once (then 409); timeline + UiEvents pushed', async () => {
    const res = await call('POST', '/alerts/a1/ack', member);
    expect(res.json()).toMatchObject({ status: 'acknowledged', ackBy: ids.member });
    expect((await call('POST', '/alerts/a1/ack', lead)).json().error.code).toBe('invalid_state');
    await new Promise((r) => setTimeout(r, 50));
    expect(
      ui.some((e) => e.type === 'alert.updated' && e.alertId === 'a1' && e.patch.status === 'acknowledged'),
    ).toBe(true);
    expect(ui.some((e) => e.type === 'timeline.appended' && e.entry.kind === 'ack')).toBe(true);
  });

  it('resolve clears the dedup key so the next event opens a new alert', async () => {
    await ctx.redis.hset(dedupKey(String(base.ruleId), 'g-a1'), 'alertId', 'a1');
    expect((await call('POST', '/alerts/a1/resolve', lead, { note: 'fixed' })).json().status).toBe(
      'resolved',
    );
    expect(await ctx.redis.exists(dedupKey(String(base.ruleId), 'g-a1'))).toBe(0);
    const again = await call('POST', '/alerts/a1/resolve', lead);
    expect(again.json()).toMatchObject({ error: { code: 'invalid_state' } });
  });

  it('comments go to the timeline', async () => {
    expect((await call('POST', '/alerts/a1/comment', member, { text: 'looking' })).statusCode).toBe(201);
    const tl = (await call('GET', '/alerts/a1', member)).json().timeline;
    expect(tl.map((e: { kind: string }) => e.kind)).toEqual(['ack', 'resolve', 'comment']);
    expect(tl[2]).toMatchObject({ actorName: ids.member, data: { text: 'looking' } });
  });

  it('manual step: complete once; unknown step 404', async () => {
    expect((await call('POST', '/alerts/a1/steps/s1/complete', member)).statusCode).toBe(200);
    expect((await call('POST', '/alerts/a1/steps/s1/complete', member)).json().error.code).toBe(
      'already_done',
    );
    expect((await call('POST', '/alerts/a1/steps/nope/complete', member)).statusCode).toBe(404);
    expect((await call('POST', '/alerts/a1/steps/s2/run', member)).json().error.code).toBe(
      'approval_required',
    );
    expect((await call('POST', '/alerts/a1/steps/s1/run', member)).statusCode).toBe(200);
  });

  it('approval must belong to the alert; decided once', async () => {
    expect(
      (await call('POST', '/alerts/a1/approvals/ap_b/decide', admin, { decision: 'approved' })).statusCode,
    ).toBe(404);
    const ok = await call('POST', '/alerts/a1/approvals/ap1/decide', member, { decision: 'approved' });
    expect(ok.json()).toMatchObject({ ok: true, stepId: 's2' });
    const again = await call('POST', '/alerts/a1/approvals/ap1/decide', member, { decision: 'rejected' });
    expect(again.json().error.code).toBe('already_decided');
    const [row] = await ctx.db.select().from(t.approvals).where(eq(t.approvals.id, 'ap1'));
    expect(row).toMatchObject({ status: 'approved', decidedBy: ids.member, via: 'ui' });
  });
});

describe('email approval links', () => {
  it('GET only shows the request; POST decides; bad tokens are rejected', async () => {
    const info = await ctx.app.inject({ method: 'GET', url: `/approve/${TOKEN}` });
    expect(info.json()).toMatchObject({ status: 'pending', stepId: 's2' });
    const [before] = await ctx.db.select().from(t.approvals).where(eq(t.approvals.id, 'ap2'));
    expect(before?.status).toBe('pending');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/approve/${TOKEN}`,
      payload: { decision: 'rejected' },
    });
    expect(res.json()).toEqual({ ok: true, decision: 'rejected' });
    const [after] = await ctx.db.select().from(t.approvals).where(eq(t.approvals.id, 'ap2'));
    expect(after).toMatchObject({ status: 'rejected', via: 'email' });

    expect((await ctx.app.inject({ method: 'GET', url: '/approve/9z9z' })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'GET', url: `/approve/${'y'.repeat(40)}` })).statusCode).toBe(404);
  });
});
