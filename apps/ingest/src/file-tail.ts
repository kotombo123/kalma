import { open, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { sourceOffsetKey, streamFor, type Logger, type Redis } from '@alerting/config';
import type { ParserOptions, Source } from '@alerting/contracts';
import { and, eq, t, type Db } from '@alerting/db';
import { messagesTotal, rejectedTotal, toEnvelopes } from './envelopes.ts';
import type { LeaseStore } from './lease.ts';
import { LeasedSources } from './leased.ts';
import type { EventSink } from './sink.ts';

export interface FileSource {
  id: string;
  orgId: string;
  format: Source['format'];
  parserOptions?: ParserOptions;
  path: string;
  /** Regex marking the first line of a record; other lines continue the previous record. */
  recordStart?: string;
}

export type LoadFileSources = () => Promise<FileSource[]>;

/** Enabled `file` sources from Postgres. */
export function dbFileSources(db: Db): LoadFileSources {
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
      .where(and(eq(t.sources.transport, 'file'), eq(t.sources.enabled, true)));
    return rows.flatMap(({ config, ...row }) =>
      config.transport === 'file'
        ? [
            {
              ...row,
              format: row.format as Source['format'],
              parserOptions: row.parserOptions ?? undefined,
              path: config.path,
              ...(config.recordStart && { recordStart: config.recordStart }),
            },
          ]
        : [],
    );
  };
}

export interface Offset {
  ino: number;
  pos: number;
}

export interface OffsetStore {
  get(sourceId: string): Promise<Offset | undefined>;
  set(sourceId: string, offset: Offset): Promise<void>;
}

export function redisOffsets(redis: Redis): OffsetStore {
  return {
    async get(id) {
      const h = await redis.hgetall(sourceOffsetKey(id));
      return h.ino === undefined || h.pos === undefined
        ? undefined
        : { ino: Number(h.ino), pos: Number(h.pos) };
    },
    async set(id, o) {
      await redis.hset(sourceOffsetKey(id), 'ino', o.ino, 'pos', o.pos);
    },
  };
}

export function memoryOffsets(): OffsetStore & { map: Map<string, Offset> } {
  const map = new Map<string, Offset>();
  return {
    map,
    get: async (id) => map.get(id),
    set: async (id, o) => void map.set(id, { ...o }),
  };
}

const NL = 0x0a;
const CHUNK = 1024 * 1024;

export interface TailerOptions {
  offsets: OffsetStore;
  onRecords: (records: string[]) => Promise<void>;
  /** A multi-line record still open after this long without new data is emitted. */
  idleFlushMs?: number;
  now?: () => number;
  log?: Logger;
}

/**
 * Follows one file like `tail -F`: a new source starts at the end of the file, a known one at
 * its stored offset. Rotation (another inode) restarts at 0 of the new file, truncation (size
 * below the offset) too. Only complete lines are read; with `recordStart`, continuation lines
 * (stack traces) join the record before them. The offset stored in Redis always points at the
 * start of the first record not yet in `stream:events`, so a crash re-reads, never skips.
 */
export class FileTailer {
  private ino: number | undefined;
  /** Bytes consumed from the file (complete lines handed to records or still pending). */
  private pos = 0;
  /** Lines of the record being assembled, and how many bytes they took. */
  private pending: string[] = [];
  private pendingBytes = 0;
  private lastData = 0;
  private readonly recordStart?: RegExp;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    readonly source: FileSource,
    private readonly opts: TailerOptions,
  ) {
    this.recordStart = source.recordStart ? new RegExp(source.recordStart) : undefined;
  }

  start(intervalMs = 250): void {
    this.stopped = false;
    const loop = async () => {
      try {
        await this.poll();
      } catch (err) {
        this.opts.log?.warn({ err, sourceId: this.source.id }, 'file tail poll failed');
      }
      // A poll still running when stop() was called must not schedule the next one.
      if (!this.stopped) this.timer = setTimeout(loop, intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** One read of whatever was appended since the last call. */
  async poll(): Promise<void> {
    const now = (this.opts.now ?? Date.now)();
    let st;
    try {
      st = await stat(this.source.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // may be created later
      throw err;
    }

    if (this.ino === undefined) {
      const saved = await this.opts.offsets.get(this.source.id);
      // Same file and still long enough: continue; otherwise rotated while we were away → from 0;
      // never seen → from the end (only new lines, like tail -f).
      this.pos = saved && saved.ino === st.ino && saved.pos <= st.size ? saved.pos : saved ? 0 : st.size;
      this.ino = st.ino;
      if (!saved) await this.opts.offsets.set(this.source.id, { ino: st.ino, pos: this.pos });
    } else if (st.ino !== this.ino || st.size < this.pos) {
      this.opts.log?.info(
        { sourceId: this.source.id, rotated: st.ino !== this.ino },
        'file rotated or truncated',
      );
      this.ino = st.ino;
      this.pos = 0;
      this.pending = [];
      this.pendingBytes = 0;
    }

    const records: string[] = [];
    if (st.size > this.pos) {
      const fh = await open(this.source.path, 'r');
      let buf: Buffer;
      try {
        const len = Math.min(st.size - this.pos, CHUNK);
        buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.pos);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      // Only up to the last newline: a half-written line is read again next time.
      const end = buf.lastIndexOf(NL);
      if (end >= 0) {
        let start = 0;
        while (start <= end) {
          const nl = buf.indexOf(NL, start);
          const line = buf.subarray(start, nl).toString('utf8').replace(/\r$/, '');
          this.addLine(line, nl - start + 1, records);
          start = nl + 1;
        }
        this.pos += end + 1;
        this.lastData = now;
      }
    }
    // An open multi-line record is complete once the file has been quiet for a moment.
    if (this.pending.length && now - this.lastData >= (this.opts.idleFlushMs ?? 500))
      this.closePending(records);

    if (!records.length) return;
    const committed = this.pos - this.pendingBytes;
    try {
      await this.opts.onRecords(records);
    } catch (err) {
      // Not in stream:events: read these lines again from the last stored offset.
      const saved = await this.opts.offsets.get(this.source.id);
      this.pos = saved?.ino === this.ino ? saved.pos : 0;
      this.pending = [];
      this.pendingBytes = 0;
      throw err;
    }
    await this.opts.offsets.set(this.source.id, { ino: this.ino, pos: committed });
  }

  private addLine(line: string, bytes: number, out: string[]) {
    if (!this.recordStart) {
      if (line.trim()) out.push(line);
      return;
    }
    if (this.recordStart.test(line) || !this.pending.length) this.closePending(out);
    this.pending.push(line);
    this.pendingBytes += bytes;
  }

  private closePending(out: string[]) {
    const text = this.pending.join('\n');
    if (text.trim()) out.push(text);
    this.pending = [];
    this.pendingBytes = 0;
  }
}

export interface FileTailManagerOptions {
  /** Unique per ingest process: the lease owner token. */
  owner: string;
  /** File sources must resolve inside this directory (FILE_SOURCE_ROOT). */
  root: string;
  eventStreamShards: number;
  validate?: boolean;
  leaseMs?: number;
  pollMs?: number;
  idleFlushMs?: number;
  now?: () => number;
  log?: Logger;
}

/**
 * Exactly one ingest instance tails each enabled file source (see `LeasedSources`); paths must
 * resolve inside FILE_SOURCE_ROOT.
 */
export class FileTailManager {
  private readonly sources: LeasedSources<FileSource>;

  constructor(
    load: LoadFileSources,
    leases: LeaseStore,
    private readonly offsets: OffsetStore,
    private readonly sink: EventSink,
    private readonly opts: FileTailManagerOptions,
  ) {
    this.sources = new LeasedSources({
      kind: 'file tail',
      load,
      leases,
      owner: opts.owner,
      leaseMs: opts.leaseMs,
      log: opts.log,
      keyOf: (s) =>
        JSON.stringify([s.path, s.recordStart ?? null, s.format, s.parserOptions ?? null, s.orgId]),
      allowed: (s) => {
        if (this.inRoot(s.path)) return true;
        opts.log?.warn(
          { sourceId: s.id, path: s.path, root: opts.root },
          'file source outside FILE_SOURCE_ROOT',
        );
        return false;
      },
      start: (s) => {
        const tailer = new FileTailer(s, {
          offsets: this.offsets,
          onRecords: (records) => this.handle(s, records),
          idleFlushMs: opts.idleFlushMs,
          now: opts.now,
          log: opts.log,
        });
        tailer.start(opts.pollMs);
        return tailer;
      },
    });
  }

  get active(): string[] {
    return this.sources.active;
  }

  sync(): Promise<void> {
    return this.sources.sync();
  }

  stopAll(): Promise<void> {
    return this.sources.stopAll();
  }

  /**
   * Writes records of one file to its `stream:events` shard. A record that cannot become an
   * envelope is dropped and counted (like a 400 over HTTP): retrying it would block the file.
   * Only a failed write to Redis throws, so the tailer reads the lines again.
   */
  async handle(source: FileSource, records: string[]): Promise<void> {
    const ingestTs = (this.opts.now ?? Date.now)();
    const payloads = records.flatMap((body) => {
      try {
        return toEnvelopes(source, body, { ingestTs, validate: this.opts.validate }).payloads;
      } catch (err) {
        rejectedTotal.inc({ reason: 'invalid_envelope' });
        this.opts.log?.warn({ err, sourceId: source.id }, 'file record dropped');
        return [];
      }
    });
    if (!payloads.length) return;
    await this.sink.add(streamFor(source.id, this.opts.eventStreamShards), payloads);
    messagesTotal.inc({ source: source.id, transport: 'file' }, payloads.length);
  }

  private inRoot(path: string) {
    const root = resolve(this.opts.root);
    const full = resolve(path);
    return full === root || full.startsWith(root + sep);
  }
}
