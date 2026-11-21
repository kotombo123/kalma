import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFixture, readJsonFixture } from '@alerting/contracts/fixtures';
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

const yamlSource = readFixture('runbooks/settlement-timeout.yaml');

describe('POST /runbooks/parse', () => {
  it('YAML: steps, actions with risk, matches as a condition, test fill on a sample', async () => {
    const res = await call('POST', '/runbooks/parse', member, {
      format: 'yaml',
      source: yamlSource,
      sample: readJsonFixture('events/workflow-failed.json'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.steps).toHaveLength(3);
    expect(body.steps.map((s: { risk: string | null }) => s.risk)).toEqual(['low', 'low', 'high']);
    expect(body.matches).toEqual({
      all: [
        { field: 'type', op: 'eq', value: 'WORKFLOW_FAILED' },
        { field: 'error.code', op: 'eq', value: 'TIMEOUT' },
      ],
    });
    expect(JSON.stringify(body.filled)).toContain('WF-20261023-00042');
  });

  it.each([
    ['markdown', readFixture('runbooks/payments-high-error-rate.md'), 4],
    ['checklist', '- [ ] Check dashboard\n- [ ] Call on-call', 2],
    ['link', 'https://wiki.example/runbooks/pricing', 1],
    ['text', readFixture('runbooks/pricing-latency.txt'), 1],
  ])('%s parses into steps', async (format, source, n) => {
    const res = await call('POST', '/runbooks/parse', member, { format, source });
    expect(res.json().steps).toHaveLength(n);
  });

  it('link runbooks accept only http(s) (no javascript: links)', async () => {
    for (const source of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x']) {
      const res = await call('POST', '/runbooks/parse', member, { format: 'link', source });
      expect(res.json().error.code).toBe('runbook_invalid');
    }
  });

  it('broken YAML → 400 runbook_invalid; unknown action → warning', async () => {
    const bad = await call('POST', '/runbooks/parse', member, { format: 'yaml', source: 'steps: [' });
    expect(bad.json().error.code).toBe('runbook_invalid');
    const unknown = await call('POST', '/runbooks/parse', member, {
      format: 'yaml',
      source: 'runbook: x\nsteps:\n  - action: launch_rockets\n',
    });
    expect(unknown.json().warnings.join(' ')).toContain('launch_rockets');
  });
});

describe('runbooks CRUD', () => {
  let id: string;

  it('lead creates for own team (201, steps stored); member and other teams cannot', async () => {
    const res = await call('POST', '/runbooks', lead, {
      teamId: ids.teamA,
      name: 'settlement-timeout',
      format: 'yaml',
      source: yamlSource,
    });
    expect(res.statusCode).toBe(201);
    id = res.json().id;
    expect(res.json()).toMatchObject({ version: 1, teamName: 'Team A' });
    expect(res.json().steps).toHaveLength(3);
    expect(
      (await call('POST', '/runbooks', member, { teamId: ids.teamA, name: 'x', format: 'text', source: 'x' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('POST', '/runbooks', lead, { teamId: ids.teamB, name: 'x', format: 'text', source: 'x' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call('POST', '/runbooks', admin, {
          teamId: ids.otherTeam,
          name: 'x',
          format: 'text',
          source: 'x',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('list and detail are org-scoped; actions catalog', async () => {
    const list = (await call('GET', '/runbooks', member)).json();
    expect(list.data.find((r: { id: string }) => r.id === id)).toMatchObject({
      stepCount: 3,
      format: 'yaml',
    });
    expect((await call('GET', `/runbooks/${id}`, outsider)).statusCode).toBe(404);
    const actions = (await call('GET', '/runbooks/actions', member)).json().data;
    expect(actions.map((a: { name: string }) => a.name)).toEqual(
      expect.arrayContaining(['http_get', 'escalate', 'retry_workflow']),
    );
  });

  it('PUT bumps the version; stale version → 409', async () => {
    const res = await call('PUT', `/runbooks/${id}`, lead, {
      teamId: ids.teamA,
      name: 'settlement-timeout v2',
      format: 'checklist',
      source: '- [ ] a\n- [ ] b',
      version: 1,
    });
    expect(res.json()).toMatchObject({ version: 2, format: 'checklist' });
    expect(res.json().steps).toHaveLength(2);
    const stale = await call('PUT', `/runbooks/${id}`, lead, {
      teamId: ids.teamA,
      name: 'x',
      format: 'text',
      source: 'x',
      version: 1,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('delete is refused while a rule uses the runbook', async () => {
    await ctx.db.insert(t.rules).values({
      id: 'r_rb',
      orgId: ids.org,
      teamId: ids.teamA,
      name: 'uses runbook',
      definition: { runbookId: id } as never,
    });
    expect((await call('DELETE', `/runbooks/${id}`, lead)).json().error.code).toBe('runbook_in_use');
    await ctx.db.delete(t.rules).where(eq(t.rules.id, 'r_rb'));
    expect((await call('DELETE', `/runbooks/${id}`, member)).statusCode).toBe(403);
    expect((await call('DELETE', `/runbooks/${id}`, lead)).statusCode).toBe(204);
  });
});
