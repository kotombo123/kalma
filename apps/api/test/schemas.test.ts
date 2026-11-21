import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_CHANGED, recentEventsKey, Redis } from '@alerting/config';
import { readFixture, readJsonFixture } from '@alerting/contracts/fixtures';
import { eq, t } from '@alerting/db';
import { fingerprint, flatten } from '@alerting/schema';
import { bearer, ids, login, setup, type TestCtx } from './setup.ts';

let ctx: TestCtx;
let sub: Redis;
const published: { kind: string; id?: string; version?: number }[] = [];
let admin: string, lead: string, member: string, outsider: string;

const workflow = readJsonFixture<Record<string, unknown>>('events/workflow-failed.json');
const judges = readJsonFixture<Record<string, unknown>>('events/judges-unknown.json');
const SCHEMA = 'sch_workflow';
const OTHER = 'sch_other_org';

beforeAll(async () => {
  ctx = await setup();
  sub = ctx.redis.duplicate();
  await sub.subscribe(CONFIG_CHANGED);
  sub.on('message', (_c, m) => published.push(JSON.parse(m)));
  const tokens = await Promise.all(
    [ids.admin, ids.lead, ids.member, ids.outsider].map((u) => login(ctx.app, u)),
  );
  [admin, lead, member, outsider] = tokens as [string, string, string, string];

  await ctx.db.insert(t.systems).values([
    { id: 'sys', orgId: ids.org, name: 'S' },
    { id: 'sys_o', orgId: ids.otherOrg, name: 'O' },
  ]);
  const src = {
    transport: 'kafka' as const,
    config: { transport: 'kafka' as const, topic: 't', fromBeginning: false },
  };
  await ctx.db.insert(t.sources).values([
    {
      id: 'src',
      orgId: ids.org,
      systemId: 'sys',
      name: 'Kafka',
      ...src,
      apiKeyHash: 'h1',
      apiKeyPrefix: 'p',
    },
    {
      id: 'src_o',
      orgId: ids.otherOrg,
      systemId: 'sys_o',
      name: 'K',
      ...src,
      apiKeyHash: 'h2',
      apiKeyPrefix: 'p',
    },
  ]);
  // the worker stores schemas without fields/guesses in some paths — the API fills them in
  await ctx.db.insert(t.schemas).values([
    {
      id: SCHEMA,
      orgId: ids.org,
      sourceId: 'src',
      fingerprint: fingerprint(flatten(workflow)),
      sample: workflow,
    },
    { id: OTHER, orgId: ids.otherOrg, sourceId: 'src_o', fingerprint: 'x', sample: judges },
  ]);
  // two recent events of this schema + one of another schema
  for (const [i, wf] of [
    ['e1', 'WF-1'],
    ['e2', 'WF-2'],
  ] as const) {
    const raw = { ...workflow, workflowId: wf, severity: 'CRIT' };
    const ev = {
      id: i,
      orgId: ids.org,
      sourceId: 'src',
      ingestTs: 1,
      receivedAt: '2026-10-23T09:00:00Z',
      schemaId: SCHEMA,
      fingerprint: 'f',
      severity: 'critical',
      timestamp: '2026-10-23T09:00:00Z',
      dedupKey: wf,
      status: 'firing',
      raw,
      flat: flatten(raw),
    };
    await ctx.redis.xadd(recentEventsKey(ids.org), '*', 'd', JSON.stringify(ev));
  }
  await ctx.redis.xadd(recentEventsKey(ids.org), '*', 'd', JSON.stringify({ schemaId: 'other', bad: true }));
}, 180_000);
afterAll(async () => {
  sub?.disconnect();
  await ctx?.stop();
});

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: object) =>
  ctx.app.inject({ method, url, headers: bearer(token), ...(payload && { payload }) });

const mapping = {
  roles: {
    title: { path: 'error.message' },
    severity: { path: 'severity' },
    entity: { path: 'workflowId' },
    dedupKey: { path: 'workflowId' },
    timestamp: { path: 'timestamp' },
  },
  severityMap: { CRIT: 'critical', ERROR: 'error' },
};

describe('schemas', () => {
  it('lists new schemas of the own org with fields and guessed roles filled in', async () => {
    const res = (await call('GET', '/schemas?status=new', member)).json();
    expect(res.data.map((s: { id: string }) => s.id)).toEqual([SCHEMA]);
    const s = res.data[0];
    expect(s.sourceName).toBe('Kafka');
    expect(s.fields.map((f: { path: string }) => f.path)).toContain('error.code');
    expect(s.guessedRoles.timestamp.path).toBe('timestamp');
  });

  it('other orgs get 404', async () => {
    expect((await call('GET', `/schemas/${SCHEMA}`, outsider)).statusCode).toBe(404);
    expect((await call('GET', `/schemas/${OTHER}`, member)).statusCode).toBe(404);
    expect((await call('POST', `/schemas/${OTHER}/preview`, admin, {})).statusCode).toBe(404);
  });

  it('preview applies a draft mapping to the sample and recent events of this schema only', async () => {
    const started = Date.now();
    const res = await call('POST', `/schemas/${SCHEMA}/preview`, member, { mapping });
    expect(Date.now() - started).toBeLessThan(500);
    const body = res.json();
    expect(body.sample).toMatchObject({
      title: 'Counterparty service did not respond in 5000 ms',
      severity: 'error',
      entity: 'WF-20261023-00042',
    });
    expect(body.events.map((e: { entity: string }) => e.entity)).toEqual(['WF-2', 'WF-1']);
    expect(body.events[0].severity).toBe('critical');
  });

  it('warns about role paths not in the schema', async () => {
    const res = await call('POST', `/schemas/${SCHEMA}/preview`, member, {
      mapping: { roles: { title: { path: 'nope.field' } } },
    });
    expect(res.json().warnings).toEqual(['title: field "nope.field" is not in this schema']);
  });

  it('members cannot save mappings; leads and admins can (new version each time)', async () => {
    expect((await call('POST', `/schemas/${SCHEMA}/mapping`, member, mapping)).statusCode).toBe(403);
    const v1 = await call('POST', `/schemas/${SCHEMA}/mapping`, lead, {
      ...mapping,
      name: 'Workflow failure',
    });
    expect(v1.statusCode).toBe(201);
    expect(v1.json().mapping.version).toBe(1);
    const v2 = await call('POST', `/schemas/${SCHEMA}/mapping`, admin, mapping);
    expect(v2.json().mapping.version).toBe(2);

    const s = (await call('GET', `/schemas/${SCHEMA}`, member)).json();
    expect(s).toMatchObject({ status: 'mapped', name: 'Workflow failure', mappingId: v2.json().mapping.id });
    expect(s.mapping.version).toBe(2);
    expect((await call('GET', `/schemas/${SCHEMA}/mappings`, member)).json().data).toHaveLength(2);
    expect(published.some((p) => p.kind === 'mappings' && p.id === SCHEMA && p.version === 2)).toBe(true);

    // preview without a draft uses the saved mapping
    const pv = (await call('POST', `/schemas/${SCHEMA}/preview`, member, {})).json();
    expect(pv.sample.title).toBe('Counterparty service did not respond in 5000 ms');
  });

  it('rejects invalid mappings', async () => {
    const bad = await call('POST', `/schemas/${SCHEMA}/mapping`, admin, {
      roles: { colour: { path: 'x' } },
      severityMap: { X: 'loud' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('PATCH renames / ignores; only mappers', async () => {
    expect((await call('PATCH', `/schemas/${SCHEMA}`, member, { status: 'ignored' })).statusCode).toBe(403);
    expect((await call('PATCH', `/schemas/${SCHEMA}`, admin, { status: 'ignored' })).json().status).toBe(
      'ignored',
    );
    await ctx.db.update(t.schemas).set({ status: 'mapped' }).where(eq(t.schemas.id, SCHEMA));
  });
});

describe('presets (B1-05)', () => {
  it('lists presets and recognizes Alertmanager in a pasted example, with a ready mapping', async () => {
    const list = (await call('GET', '/schemas/presets', member)).json();
    expect(list.data.map((p: { id: string }) => p.id)).toContain('alertmanager');
    const res = (
      await call('POST', '/schemas/test', member, { body: readFixture('events/alertmanager-firing.json') })
    ).json();
    expect(res.preset.id).toBe('alertmanager');
    expect(res.preset.mapping.roles.title).toBeDefined();
  });
});

describe('POST /schemas/test (paste an example)', () => {
  it('parses JSON, guesses roles and recognizes a known schema', async () => {
    const res = (
      await call('POST', '/schemas/test', member, {
        body: JSON.stringify({ ...workflow, workflowId: 'WF-9' }),
        contentType: 'application/json',
      })
    ).json();
    expect(res).toMatchObject({
      format: 'json',
      parseError: false,
      recordCount: 1,
      knownSchema: { id: SCHEMA },
    });
    expect(res.normalized.severity).toBe('error');
  });

  it('handles the unknown judges schema and other formats without saving', async () => {
    const before = await ctx.db.select().from(t.schemas);
    const j = (await call('POST', '/schemas/test', member, { body: JSON.stringify(judges) })).json();
    expect(j.knownSchema).toBeNull();
    expect(j.guessedRoles.severity.path).toBe('lvl');
    const lf = (
      await call('POST', '/schemas/test', member, { body: readFixture('events/logfmt.log') })
    ).json();
    expect(lf.format).toBe('logfmt');
    const csv = (
      await call('POST', '/schemas/test', member, { body: readFixture('events/reconciliation.csv') })
    ).json();
    expect(csv.recordCount).toBe(2);
    expect(await ctx.db.select().from(t.schemas)).toHaveLength(before.length);
  });

  it('requires auth and rejects empty bodies', async () => {
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/schemas/test', payload: { body: 'x' } })).statusCode,
    ).toBe(401);
    expect((await call('POST', '/schemas/test', member, { body: '' })).statusCode).toBe(400);
  });
});
