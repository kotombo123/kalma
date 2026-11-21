import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONFIG_CHANGED, recentEventsKey, Redis } from '@alerting/config';
import { RuleFile } from '@alerting/contracts';
import { t } from '@alerting/db';
import { bearer, ids, login, setup, type TestCtx } from './setup.ts';

let ctx: TestCtx;
let sub: Redis;
const published: { kind: string; id?: string; version?: number }[] = [];
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
  await ctx.db.insert(t.systems).values({ id: 'sys', orgId: ids.org, name: 'S' });
  await ctx.db.insert(t.sources).values({
    id: 'src',
    orgId: ids.org,
    systemId: 'sys',
    name: 'K',
    transport: 'http',
    config: { transport: 'http' },
    apiKeyHash: 'h',
    apiKeyPrefix: 'p',
  });
  await ctx.db.insert(t.schemas).values({
    id: 'sch',
    orgId: ids.org,
    sourceId: 'src',
    fingerprint: 'f',
    fields: [
      { path: 'meta.schema', type: 'string', example: 'trade.rejected.v2' },
      { path: 'payload.desk', type: 'string', example: 'rates' },
      { path: 'payload.notional', type: 'number', example: 25000000 },
    ],
  });
  await ctx.db.insert(t.runbooks).values({
    id: 'rb',
    orgId: ids.org,
    teamId: ids.teamA,
    name: 'rates-runbook',
    format: 'text',
    source: 'x',
  });
}, 180_000);
afterAll(async () => {
  sub?.disconnect();
  await ctx?.stop();
});

const call = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  token: string,
  payload?: object,
) => ctx.app.inject({ method, url, headers: bearer(token), ...(payload && { payload }) });

/** Appendix B — Team Rates. */
const rates = (over: object = {}) => ({
  teamId: ids.teamA,
  name: 'Large rejected rates trades',
  condition: {
    all: [
      { field: 'meta.schema', op: 'glob', value: 'trade.rejected.*' },
      { field: 'payload.desk', op: 'eq', value: 'rates' },
      { field: 'payload.notional', op: 'gt', value: 10_000_000 },
    ],
  },
  presentation: { titleTemplate: 'Rejected {{payload.currency}} {{payload.notional}} — {{payload.reason}}' },
  dedup: { keyTemplate: '{{payload.tradeId}}', windowSec: 3600 },
  routing: { targets: [{ type: 'team', teamId: ids.teamA }], channels: ['email', 'ui'] },
  runbookId: 'rb',
  ...over,
});

const event = (i: number, desk: string, notional: number) => {
  const flat = { 'meta.schema': 'trade.rejected.v2', 'payload.desk': desk, 'payload.notional': notional };
  return {
    id: `ev${i}`,
    orgId: ids.org,
    sourceId: i % 2 ? 'src' : 'src2',
    ingestTs: i,
    receivedAt: '2026-10-23T09:00:00Z',
    schemaId: 'sch',
    fingerprint: 'f',
    severity: 'error',
    timestamp: '2026-10-23T09:00:00Z',
    title: `trade ${i}`,
    dedupKey: `t${i}`,
    status: 'firing',
    raw: {},
    flat,
  };
};

describe('POST /rules/preview', () => {
  beforeAll(async () => {
    // 10 events: 4 rates > 10M, 3 rates small, 3 fx
    const evs = [
      ...[1, 2, 3, 4].map((i) => event(i, 'rates', 25_000_000)),
      ...[5, 6, 7].map((i) => event(i, 'rates', 1_000)),
      ...[8, 9, 10].map((i) => event(i, 'fx', 50_000_000)),
    ];
    for (const e of evs) await ctx.redis.xadd(recentEventsKey(ids.org), '*', 'd', JSON.stringify(e));
    await ctx.redis.xadd(recentEventsKey(ids.org), '*', 'd', 'not json');
    await ctx.redis.xadd(
      recentEventsKey(ids.otherOrg),
      '*',
      'd',
      JSON.stringify({ ...event(99, 'rates', 9e9), orgId: ids.otherOrg }),
    );
  });

  it('counts matches among recent events of the own org (Team Rates rule)', async () => {
    const res = await call('POST', '/rules/preview', member, {
      condition: rates().condition,
      maxExamples: 2,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ matched: 4, total: 10, window: 10 });
    expect(body.examples).toHaveLength(2);
    expect(body.examples[0]).toMatchObject({ severity: 'error', flat: { 'payload.desk': 'rates' } });
  });

  it('applies the scope', async () => {
    const body = (
      await call('POST', '/rules/preview', member, {
        condition: rates().condition,
        scope: { sourceIds: ['src'] },
      })
    ).json();
    expect(body).toMatchObject({ matched: 2, total: 5 });
  });

  it('returns issues for an invalid condition', async () => {
    const res = await call('POST', '/rules/preview', member, {
      condition: { field: 'payload.desk', op: 'in', value: 'rates' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.issues[0].path).toEqual(['condition', 'value']);
  });
});

describe('rules', () => {
  let ruleId: string;

  it('team lead creates a rule for their team (201, version 1); config:changed is published', async () => {
    const res = await call('POST', '/rules', lead, rates());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    ruleId = body.id;
    expect(res.headers.location).toBe(`/rules/${ruleId}`);
    expect(body).toMatchObject({ version: 1, origin: 'ui', enabled: true, teamName: 'Team A', warnings: [] });
    expect(body.definition.autoResolve).toEqual({ onSourceResolved: true, onRunbookSuccess: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(published).toContainEqual({ kind: 'rules', orgId: ids.org, id: ruleId, version: 1 });
  });

  it('members and leads of other teams cannot write', async () => {
    expect((await call('POST', '/rules', member, rates())).statusCode).toBe(403);
    expect((await call('POST', '/rules', lead, rates({ teamId: ids.teamB }))).statusCode).toBe(403);
    expect((await call('POST', '/rules', admin, rates({ teamId: ids.teamB }))).statusCode).toBe(201);
  });

  it('rejects references to another org and bad operator values with field-level issues', async () => {
    const res = await call(
      'POST',
      '/rules',
      admin,
      rates({
        teamId: ids.otherTeam,
        condition: {
          any: [
            { field: 'payload.desk', op: 'in', value: 'rates' },
            { field: 'x', op: 'matches', value: '(' },
            { field: '$color', op: 'eq', value: 'red' },
          ],
        },
      }),
    );
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('rule_invalid');
    expect(error.issues.map((i: { path: unknown[] }) => i.path.join('.'))).toEqual(
      expect.arrayContaining([
        'teamId',
        'condition.any.0.value',
        'condition.any.1.value',
        'condition.any.2.field',
      ]),
    );
  });

  it('broken templates are errors with their path', async () => {
    const v = (
      await call('POST', '/rules/validate', member, {
        rule: rates({
          presentation: {
            titleTemplate: 'Rejected {{#if x}}open',
            fields: [{ label: 'a', template: '{{ok}}' }],
          },
        }),
      })
    ).json();
    expect(v.valid).toBe(false);
    expect(v.issues.map((i: { path: unknown[] }) => i.path.join('.'))).toEqual([
      'presentation.titleTemplate',
    ]);
  });

  it('unknown fields are warnings, not errors; /rules/validate saves nothing', async () => {
    const before = (await call('GET', '/rules', admin)).json().data.length;
    const v = (
      await call('POST', '/rules/validate', member, {
        rule: rates({ condition: { field: 'payload.typo', op: 'exists' } }),
      })
    ).json();
    expect(v).toMatchObject({ valid: true, issues: [] });
    expect(v.warnings[0].message).toContain('payload.typo');
    const broken = (await call('POST', '/rules/validate', member, { rule: { name: 'x' } })).json();
    expect(broken.valid).toBe(false);
    expect(broken.issues.length).toBeGreaterThan(0);
    expect((await call('GET', '/rules', admin)).json().data.length).toBe(before);
  });

  it('PUT saves a new version; a stale version gets 409', async () => {
    const res = await call('PUT', `/rules/${ruleId}`, lead, {
      ...rates({ name: 'Rates > 10M' }),
      version: 1,
    });
    expect(res.json()).toMatchObject({ version: 2, name: 'Rates > 10M' });
    const stale = await call('PUT', `/rules/${ruleId}`, lead, { ...rates({ name: 'Old' }), version: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('version_conflict');
  });

  it('PATCH toggles enabled; versions, diff and rollback', async () => {
    expect((await call('PATCH', `/rules/${ruleId}`, lead, { enabled: false })).json()).toMatchObject({
      version: 3,
      enabled: false,
    });
    const versions = (await call('GET', `/rules/${ruleId}/versions`, member)).json().data;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([3, 2, 1]);
    expect(versions[0].authorName).toBe(ids.lead);

    const d = (await call('GET', `/rules/${ruleId}/diff?from=1&to=3`, member)).json();
    expect(d.changes).toEqual([
      { path: 'enabled', before: true, after: false },
      { path: 'name', before: 'Large rejected rates trades', after: 'Rates > 10M' },
    ]);

    const rb = (await call('POST', `/rules/${ruleId}/rollback`, lead, { version: 1 })).json();
    expect(rb).toMatchObject({ version: 4, enabled: true, name: 'Large rejected rates trades' });
    expect((await call('GET', `/rules/${ruleId}/versions/9`, member)).statusCode).toBe(404);
  });

  it('exports YAML that parses back as a RuleFile (team / runbook by name)', async () => {
    const res = await call('GET', `/rules/${ruleId}/yaml`, member);
    expect(res.headers['content-type']).toContain('application/yaml');
    const file = RuleFile.parse(parse(res.body));
    expect(file).toMatchObject({ team: 'team-a', runbook: 'rates-runbook', origin: 'file' });
    expect(file.routing.targets).toEqual([{ type: 'team', team: 'team-a' }]);
    expect(res.body).not.toContain(ids.org);
  });

  it('file rules are read-only; other orgs get 404', async () => {
    await ctx.db.insert(t.rules).values({
      id: 'r_file',
      orgId: ids.org,
      teamId: ids.teamA,
      name: 'from file',
      definition: { ...rates(), id: 'r_file', orgId: ids.org, origin: 'file' } as never,
      origin: 'file',
      filePath: 'config/rules/x.yaml',
    });
    const put = await call('PUT', '/rules/r_file', admin, rates());
    expect(put.statusCode).toBe(409);
    expect(put.json().error.message).toContain('config/rules/x.yaml');
    expect((await call('DELETE', '/rules/r_file', admin)).statusCode).toBe(409);
    expect((await call('GET', `/rules/${ruleId}`, outsider)).statusCode).toBe(404);
    expect(
      (await call('GET', '/rules?origin=file', member)).json().data.map((r: { id: string }) => r.id),
    ).toEqual(['r_file']);
  });

  it('delete (204)', async () => {
    expect((await call('DELETE', `/rules/${ruleId}`, member)).statusCode).toBe(403);
    expect((await call('DELETE', `/rules/${ruleId}`, lead)).statusCode).toBe(204);
    expect((await call('GET', `/rules/${ruleId}`, lead)).statusCode).toBe(404);
  });
});
