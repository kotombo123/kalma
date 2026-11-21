import { Envelope, SEED, SEED_API_KEYS } from '@alerting/contracts';
import { readFixture } from '@alerting/contracts/fixtures';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type IngestConfig } from '../src/app.ts';
import type { EventSink } from '../src/sink.ts';
import { keyMatches, sha256, SourceCache, type IngestSource } from '../src/sources.ts';

const KEY = SEED_API_KEYS.http;
const SOURCE: IngestSource = {
  id: SEED.sources.http,
  orgId: SEED.orgId,
  transport: 'http',
  format: 'auto',
  apiKeyHash: sha256(KEY),
  enabled: true,
};

function memorySink() {
  const streams = new Map<string, string[]>();
  const sink: EventSink & { streams: typeof streams; fill(stream: string, n: number): void } = {
    streams,
    async add(stream, payloads) {
      streams.set(stream, [...(streams.get(stream) ?? []), ...payloads]);
    },
    async backlog(stream) {
      return streams.get(stream)?.length ?? 0;
    },
    fill(stream, n) {
      streams.set(
        stream,
        Array.from({ length: n }, () => '{}'),
      );
    },
  };
  return sink;
}

async function setup(sources: IngestSource[] = [SOURCE], config: Partial<IngestConfig> = {}) {
  const sink = memorySink();
  const byId = new Map(sources.map((s) => [s.id, s]));
  let loads = 0;
  const cache = new SourceCache(async (id) => {
    loads++;
    return byId.get(id);
  });
  const app = await buildApp({ sources: cache, sink, config: { validate: true, ...config } });
  const envelopes = () => (sink.streams.get('stream:events') ?? []).map((d) => Envelope.parse(JSON.parse(d)));
  return { app, sink, cache, byId, envelopes, loads: () => loads };
}

const post = (
  app: Awaited<ReturnType<typeof setup>>['app'],
  body: string,
  { key = KEY as string | null, contentType = 'application/json', url = `/ingest/${SOURCE.id}` } = {},
) =>
  app.inject({
    method: 'POST',
    url,
    payload: body,
    headers: { 'content-type': contentType, ...(key !== null && { 'x-api-key': key }) },
  });

describe('POST /ingest/:sourceId', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('accepts a JSON event: 202, one valid Envelope on stream:events', async () => {
    const body = readFixture('events/alertmanager-firing.json');
    const res = await post(ctx.app, body);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, parseError: false });
    const [env] = ctx.envelopes();
    expect(env).toMatchObject({
      orgId: SEED.orgId,
      sourceId: SEED.sources.http,
      format: 'json',
      raw: JSON.parse(body),
      rawText: body,
    });
    expect(env!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    expect(new Date(env!.receivedAt).getTime()).toBe(env!.ingestTs);
  });

  it('NDJSON batch → one envelope per line, no rawText', async () => {
    const body = ['{"a":1}', '{"a":2}', '{"a":3}'].join('\n');
    const res = await post(ctx.app, body, { contentType: 'application/x-ndjson' });
    expect(res.json()).toEqual({ accepted: 3, parseError: false });
    expect(ctx.envelopes().map((e) => e.raw)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(ctx.envelopes().every((e) => e.rawText === undefined)).toBe(true);
  });

  it.each([
    ['events/settlement-batch.xml', 'application/xml', 'xml', 1],
    ['events/reconciliation.csv', 'text/csv', 'csv', 2],
    ['events/logfmt.log', 'text/plain', 'logfmt', 1],
  ])('%s (%s) → %s, %i envelope(s)', async (fixture, contentType, format, n) => {
    const res = await post(ctx.app, readFixture(fixture), { contentType });
    expect(res.statusCode).toBe(202);
    expect(ctx.envelopes()).toHaveLength(n);
    expect(ctx.envelopes()[0]!.format).toBe(format);
  });

  it('uses the source format and parser options (grok)', async () => {
    const grok = {
      ...SOURCE,
      id: 'src-grok',
      format: 'regex' as const,
      parserOptions: { grokPattern: '%{LOGLEVEL:level} %{GREEDYDATA:message}' },
    };
    ctx = await setup([grok]);
    const res = await post(ctx.app, 'ERROR disk full\nWARN disk 90%', {
      url: '/ingest/src-grok',
      contentType: 'text/plain',
    });
    expect(res.json()).toEqual({ accepted: 2, parseError: false });
    expect(ctx.envelopes().map((e) => e.raw)).toEqual([
      { level: 'ERROR', message: 'disk full' },
      { level: 'WARN', message: 'disk 90%' },
    ]);
  });

  it('unparseable body is still accepted, flagged parseError', async () => {
    const res = await post(ctx.app, '{"broken": ', { contentType: 'application/json' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, parseError: true });
    expect(ctx.envelopes()[0]).toMatchObject({
      parseError: true,
      raw: { message: '{"broken": ', _parseError: true },
    });
  });

  it('accepts the key as ?key=', async () => {
    const res = await post(ctx.app, '{"a":1}', { key: null, url: `/ingest/${SOURCE.id}?key=${KEY}` });
    expect(res.statusCode).toBe(202);
  });

  it('rejects a missing key (401), wrong key and unknown source alike (401)', async () => {
    expect((await post(ctx.app, '{}', { key: null })).json().error.code).toBe('missing_api_key');
    const wrong = await post(ctx.app, '{}', { key: 'ak_wrong' });
    const unknown = await post(ctx.app, '{}', { url: '/ingest/nope' });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json()).toEqual(unknown.json());
    expect(ctx.envelopes()).toHaveLength(0);
  });

  it('rejects a disabled source (403)', async () => {
    ctx = await setup([{ ...SOURCE, enabled: false }]);
    const res = await post(ctx.app, '{}');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('source_disabled');
  });

  it('rejects an empty body (400) and a body over the limit (413)', async () => {
    expect((await post(ctx.app, '   ')).statusCode).toBe(400);
    ctx = await setup([SOURCE], { bodyLimit: 100 });
    expect((await post(ctx.app, JSON.stringify({ big: 'x'.repeat(200) }))).statusCode).toBe(413);
  });

  it('accepts bodies without a content-type', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/ingest/${SOURCE.id}`,
      payload: 'level=error msg=boom',
      headers: { 'x-api-key': KEY },
    });
    expect(res.statusCode).toBe(202);
    expect(ctx.envelopes()[0]!.format).toBe('logfmt');
  });

  it('backpressure: 503 + Retry-After when the stream is over the threshold', async () => {
    ctx = await setup([SOURCE], { backpressureLength: 10, backpressureCheckMs: 0 });
    ctx.sink.fill('stream:events', 11);
    const res = await post(ctx.app, '{"a":1}');
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
  });

  it('shards streams by source when EVENT_STREAM_SHARDS > 1', async () => {
    ctx = await setup([SOURCE], { eventStreamShards: 4 });
    await post(ctx.app, '{"a":1}');
    const [stream] = [...ctx.sink.streams.keys()];
    expect(stream).toMatch(/^stream:events:[0-3]$/);
  });

  it('caches source lookups', async () => {
    for (let i = 0; i < 5; i++) await post(ctx.app, '{"a":1}');
    expect(ctx.loads()).toBe(1);
  });

  it('exposes /health and /metrics', async () => {
    await post(ctx.app, '{"a":1}');
    expect((await ctx.app.inject('/health')).body).toBe('ok');
    const m = await ctx.app.inject('/metrics');
    expect(m.body).toContain(`ingest_messages_total{source="${SOURCE.id}",transport="http"}`);
  });
});

describe('SourceCache', () => {
  it('invalidate() makes a rotated key take effect', async () => {
    const ctx = await setup();
    expect((await post(ctx.app, '{}')).statusCode).toBe(202);
    ctx.byId.set(SOURCE.id, { ...SOURCE, apiKeyHash: sha256('ak_new') });
    expect((await post(ctx.app, '{}')).statusCode).toBe(202); // still cached
    ctx.cache.invalidate(SOURCE.id);
    expect((await post(ctx.app, '{}')).statusCode).toBe(401);
    expect((await post(ctx.app, '{}', { key: 'ak_new' })).statusCode).toBe(202);
  });

  it('shares one load between concurrent misses', async () => {
    let loads = 0;
    const cache = new SourceCache(async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return SOURCE;
    });
    await Promise.all(Array.from({ length: 10 }, () => cache.get(SOURCE.id)));
    expect(loads).toBe(1);
  });
});

describe('keyMatches', () => {
  it('compares against the sha256 hex', () => {
    expect(keyMatches(KEY, sha256(KEY))).toBe(true);
    expect(keyMatches('other', sha256(KEY))).toBe(false);
    expect(keyMatches(KEY, 'not-hex')).toBe(false);
  });
});
