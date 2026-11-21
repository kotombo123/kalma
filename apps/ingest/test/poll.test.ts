import { Envelope, SEED } from '@alerting/contracts';
import { describe, expect, it } from 'vitest';
import { memoryLeases } from '../src/lease.ts';
import { memoryPollState, Poller, pollManager, type Fetch, type PollSource } from '../src/poll.ts';
import type { EventSink } from '../src/sink.ts';

function memorySink() {
  const streams = new Map<string, string[]>();
  const sink: EventSink = {
    add: async (s, p) => void streams.set(s, [...(streams.get(s) ?? []), ...p]),
    backlog: async (s) => streams.get(s)?.length ?? 0,
  };
  const events = () => (streams.get('stream:events') ?? []).map((p) => Envelope.parse(JSON.parse(p)));
  return { sink, events };
}

const src = (over: Partial<PollSource> = {}): PollSource => ({
  id: SEED.sources.poll,
  orgId: SEED.orgId,
  format: 'json',
  url: 'http://demo-systems:3002/incidents',
  intervalSec: 15,
  itemsPath: 'data.items',
  idPath: 'id',
  ...over,
});

/** A fake server: each call returns the next body; records the requests. */
function server(...bodies: unknown[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' },
    });
  };
  return { fetch, calls };
}

const incident = (id: string) => ({ id, type: 'trade-rejected', severity: 'high', message: `trade ${id}` });

describe('Poller', () => {
  it('items at itemsPath become events; ids seen before are skipped', async () => {
    const mem = memorySink();
    const srv = server(
      { data: { items: [incident('a'), incident('b')] } },
      { data: { items: [incident('a'), incident('b'), incident('c')] } },
    );
    const p = new Poller(src(), {
      state: memoryPollState(),
      sink: mem.sink,
      eventStreamShards: 1,
      validate: true,
      fetch: srv.fetch,
    });
    expect(await p.poll()).toBe(2);
    expect(await p.poll()).toBe(1);
    expect(mem.events().map((e) => (e.raw as { id: string }).id)).toEqual(['a', 'b', 'c']);
    expect(mem.events()[0]).toMatchObject({ sourceId: SEED.sources.poll, format: 'json' });
  });

  it('sends configured headers and the since cursor', async () => {
    const srv = server({ data: { items: [] } });
    let t = Date.parse('2026-11-21T10:00:00Z');
    const p = new Poller(src({ headers: { authorization: 'Bearer x' }, sinceParam: 'since' }), {
      state: memoryPollState(),
      sink: memorySink().sink,
      eventStreamShards: 1,
      fetch: srv.fetch,
      now: () => t,
    });
    await p.poll();
    t += 15_000;
    await p.poll();
    expect(srv.calls[0]!.url).toBe('http://demo-systems:3002/incidents');
    expect(srv.calls[0]!.headers.authorization).toBe('Bearer x');
    expect(new URL(srv.calls[1]!.url).searchParams.get('since')).toBe('2026-11-21T10:00:00.000Z');
  });

  it('without idPath every item is new; without itemsPath a list body is the list', async () => {
    const mem = memorySink();
    const p = new Poller(src({ itemsPath: undefined, idPath: undefined }), {
      state: memoryPollState(),
      sink: mem.sink,
      eventStreamShards: 1,
      fetch: server([incident('a')]).fetch,
    });
    await p.poll();
    await p.poll();
    expect(mem.events()).toHaveLength(2);
  });

  it('a failed write to the stream does not mark items seen', async () => {
    let fail = true;
    const added: string[] = [];
    const sink: EventSink = {
      add: async (_s, p) => {
        if (fail) throw new Error('redis down');
        added.push(...p);
      },
      backlog: async () => 0,
    };
    const p = new Poller(src(), {
      state: memoryPollState(),
      sink,
      eventStreamShards: 1,
      fetch: server({ data: { items: [incident('a')] } }).fetch,
    });
    await expect(p.poll()).rejects.toThrow('redis down');
    fail = false;
    expect(await p.poll()).toBe(1);
  });

  it('non-2xx is an error; a non-JSON body is one event', async () => {
    const failing: Fetch = async () => new Response('nope', { status: 503 });
    const bad = new Poller(src(), {
      state: memoryPollState(),
      sink: memorySink().sink,
      eventStreamShards: 1,
      fetch: failing,
    });
    await expect(bad.poll()).rejects.toThrow('503');

    const mem = memorySink();
    const text = new Poller(src({ format: 'text', itemsPath: undefined }), {
      state: memoryPollState(),
      sink: mem.sink,
      eventStreamShards: 1,
      fetch: server('ERROR disk full on trade-gateway-2').fetch,
    });
    expect(await text.poll()).toBe(1);
  });

  it('itemsPath that is not a list yields nothing (and no crash)', async () => {
    const p = new Poller(src(), {
      state: memoryPollState(),
      sink: memorySink().sink,
      eventStreamShards: 1,
      fetch: server({ data: { items: 'oops' } }).fetch,
    });
    expect(await p.poll()).toBe(0);
  });
});

describe('pollManager', () => {
  it('one instance per poll source; a config change restarts it', async () => {
    const leases = memoryLeases();
    let sources = [src({ intervalSec: 3600 })];
    const srv = server({ data: { items: [] } });
    const make = (owner: string) =>
      pollManager(async () => sources, leases, memoryPollState(), memorySink().sink, {
        owner,
        eventStreamShards: 1,
        fetch: srv.fetch,
      });
    const a = make('a');
    const b = make('b');
    await a.sync();
    await b.sync();
    expect(a.active).toEqual([SEED.sources.poll]);
    expect(b.active).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(srv.calls).toHaveLength(1);

    sources = [src({ intervalSec: 3600, url: 'http://demo-systems:3002/incidents?x=1' })];
    await a.sync();
    await new Promise((r) => setTimeout(r, 20));
    expect(srv.calls.at(-1)!.url).toContain('x=1');
    await a.stopAll();
    await b.sync();
    expect(b.active).toEqual([SEED.sources.poll]);
    await b.stopAll();
  });
});
