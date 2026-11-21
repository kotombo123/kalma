import { pollCursorKey, pollSeenKey, streamFor, type Logger, type Redis } from '@alerting/config';
import type { ParserOptions, Source } from '@alerting/contracts';
import { and, eq, t, type Db } from '@alerting/db';
import { lookup, type TemplateData } from '@alerting/templates';
import { messagesTotal, rejectedTotal, toEnvelopes } from './envelopes.ts';
import type { LeaseStore } from './lease.ts';
import { LeasedSources } from './leased.ts';
import type { EventSink } from './sink.ts';

export interface PollSource {
  id: string;
  orgId: string;
  format: Source['format'];
  parserOptions?: ParserOptions;
  url: string;
  intervalSec: number;
  headers?: Record<string, string>;
  /** Where the list sits in the JSON response, e.g. `data.items`. Without it: the whole body. */
  itemsPath?: string;
  /** Item id for dedup across polls, e.g. `id`. Without it every item of every poll is new. */
  idPath?: string;
  /** Query parameter that gets the time of the last successful poll (ISO-8601). */
  sinceParam?: string;
}

export type LoadPollSources = () => Promise<PollSource[]>;

/** Enabled `poll` sources from Postgres. */
export function dbPollSources(db: Db): LoadPollSources {
  return async () => {
    const rows = await db
      .select({
        id: t.sources.id,
        orgId: t.sources.orgId,
        format: t.sources.format,
        parserOptions: t.sources.parserOptions,
        config: t.sources.config,
      })
      .from(t.sources)
      .where(and(eq(t.sources.transport, 'poll'), eq(t.sources.enabled, true)));
    return rows.flatMap(({ config: c, ...row }) =>
      c.transport === 'poll'
        ? [
            {
              ...row,
              format: row.format as Source['format'],
              parserOptions: row.parserOptions ?? undefined,
              url: c.url,
              intervalSec: c.intervalSec,
              ...(c.headers && { headers: c.headers }),
              ...(c.itemsPath && { itemsPath: c.itemsPath }),
              ...(c.idPath && { idPath: c.idPath }),
              ...(c.sinceParam && { sinceParam: c.sinceParam }),
            },
          ]
        : [],
    );
  };
}

/** Ids already ingested (with a TTL) and the `since` cursor, per source. */
export interface PollState {
  /** The subset of `ids` not seen within the TTL. */
  unseen(sourceId: string, ids: string[]): Promise<Set<string>>;
  markSeen(sourceId: string, ids: string[], now: number, ttlMs: number): Promise<void>;
  cursor(sourceId: string): Promise<string | undefined>;
  setCursor(sourceId: string, since: string): Promise<void>;
}

/** Seen ids as a sorted set scored by time: entries older than the TTL are pruned on write. */
export function redisPollState(redis: Redis): PollState {
  return {
    async unseen(id, ids) {
      if (!ids.length) return new Set();
      const scores = await redis.zmscore(pollSeenKey(id), ...ids);
      return new Set(ids.filter((_, i) => scores[i] === null));
    },
    async markSeen(id, ids, now, ttlMs) {
      if (!ids.length) return;
      const key = pollSeenKey(id);
      await redis
        .multi()
        .zadd(key, ...ids.flatMap((x) => [now, x]))
        .zremrangebyscore(key, '-inf', now - ttlMs)
        .pexpire(key, ttlMs)
        .exec();
    },
    cursor: async (id) => (await redis.get(pollCursorKey(id))) ?? undefined,
    async setCursor(id, since) {
      await redis.set(pollCursorKey(id), since);
    },
  };
}

export function memoryPollState(): PollState {
  const seen = new Map<string, Map<string, number>>();
  const cursors = new Map<string, string>();
  return {
    async unseen(id, ids) {
      const s = seen.get(id);
      return new Set(ids.filter((x) => !s?.has(x)));
    },
    async markSeen(id, ids, now, ttlMs) {
      const s = seen.get(id) ?? new Map<string, number>();
      for (const x of ids) s.set(x, now);
      for (const [x, at] of s) if (at < now - ttlMs) s.delete(x);
      seen.set(id, s);
    },
    cursor: async (id) => cursors.get(id),
    setCursor: async (id, since) => void cursors.set(id, since),
  };
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PollerOptions {
  state: PollState;
  sink: EventSink;
  eventStreamShards: number;
  validate?: boolean;
  fetch?: Fetch;
  /** How long an id stays "seen". At least a day, and 100 polling intervals. */
  seenTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  log?: Logger;
}

const MAX_BODY = 10 * 1024 * 1024;

/**
 * Polls one URL every `intervalSec`. JSON responses are split into items (`itemsPath`), items
 * already ingested are skipped (`idPath`), each new item becomes one event. Items are marked
 * seen only after they are in `stream:events`: a crash in between repeats them (the worker's
 * dedup absorbs that), it never loses them.
 */
export class Poller {
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(
    readonly source: PollSource,
    private readonly o: PollerOptions,
  ) {}

  start(): void {
    const loop = async () => {
      try {
        await this.poll();
      } catch (err) {
        this.o.log?.warn({ err, sourceId: this.source.id }, 'poll failed');
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.source.intervalSec * 1000);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.abort.abort();
  }

  /** One request; returns how many new events went to the stream. */
  async poll(): Promise<number> {
    const s = this.source;
    const now = (this.o.now ?? Date.now)();
    const startedAt = new Date(now).toISOString();

    const url = new URL(s.url);
    if (s.sinceParam) {
      const since = await this.o.state.cursor(s.id);
      if (since) url.searchParams.set(s.sinceParam, since);
    }
    const res = await (this.o.fetch ?? fetch)(url.toString(), {
      headers: { accept: 'application/json, */*', ...s.headers },
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.o.timeoutMs ?? 10_000)]),
    });
    if (!res.ok) throw new Error(`GET ${s.url} returned ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_BODY) throw new Error(`GET ${s.url} returned more than ${MAX_BODY} bytes`);
    const contentType = res.headers.get('content-type') ?? undefined;

    const items = this.items(body);
    const withIds = items.map((item) => ({ item, id: this.idOf(item) }));
    const ids = withIds.flatMap((x) => (x.id === undefined ? [] : [x.id]));
    const unseen = await this.o.state.unseen(s.id, [...new Set(ids)]);
    const fresh = withIds.filter((x) => x.id === undefined || unseen.delete(x.id));

    const payloads = fresh.flatMap(({ item }) => {
      try {
        return toEnvelopes(s, typeof item === 'string' ? item : JSON.stringify(item), {
          ingestTs: now,
          contentType: typeof item === 'string' ? contentType : 'application/json',
          validate: this.o.validate,
        }).payloads;
      } catch (err) {
        rejectedTotal.inc({ reason: 'invalid_envelope' });
        this.o.log?.warn({ err, sourceId: s.id }, 'polled item dropped');
        return [];
      }
    });
    if (payloads.length) {
      await this.o.sink.add(streamFor(s.id, this.o.eventStreamShards), payloads);
      messagesTotal.inc({ source: s.id, transport: 'poll' }, payloads.length);
    }

    const ttl = this.o.seenTtlMs ?? Math.max(86_400_000, s.intervalSec * 100_000);
    await this.o.state.markSeen(
      s.id,
      fresh.flatMap((x) => (x.id === undefined ? [] : [x.id])),
      now,
      ttl,
    );
    if (s.sinceParam) await this.o.state.setCursor(s.id, startedAt);
    return payloads.length;
  }

  /** JSON → the list at `itemsPath` (or the body if it is a list); anything else → the body. */
  private items(body: string): unknown[] {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return body.trim() ? [body] : [];
    }
    const list = this.source.itemsPath
      ? json !== null && typeof json === 'object'
        ? lookup(json as TemplateData, this.source.itemsPath)
        : undefined
      : json;
    if (Array.isArray(list)) return list;
    if (this.source.itemsPath) {
      this.o.log?.warn(
        { sourceId: this.source.id, itemsPath: this.source.itemsPath },
        'itemsPath is not a list',
      );
      return [];
    }
    return [json];
  }

  private idOf(item: unknown): string | undefined {
    if (!this.source.idPath || item === null || typeof item !== 'object') return undefined;
    const id = lookup(item as TemplateData, this.source.idPath);
    return id === undefined || id === null || id === '' ? undefined : String(id);
  }
}

export interface PollManagerOptions extends Omit<PollerOptions, 'state' | 'sink'> {
  owner: string;
  leaseMs?: number;
}

/** One ingest instance per poll source (see `LeasedSources`). */
export function pollManager(
  load: LoadPollSources,
  leases: LeaseStore,
  state: PollState,
  sink: EventSink,
  opts: PollManagerOptions,
): LeasedSources<PollSource> {
  return new LeasedSources({
    kind: 'poller',
    load,
    leases,
    owner: opts.owner,
    leaseMs: opts.leaseMs,
    log: opts.log,
    keyOf: (s) => JSON.stringify(s),
    start: (s) => {
      const p = new Poller(s, { ...opts, state, sink });
      p.start();
      return p;
    },
  });
}
