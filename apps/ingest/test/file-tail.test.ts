import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Envelope, SEED } from '@alerting/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTailer, FileTailManager, memoryOffsets, type FileSource } from '../src/file-tail.ts';
import { memoryLeases } from '../src/lease.ts';
import type { EventSink } from '../src/sink.ts';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tail-'));
  path = join(dir, 'app.log');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const src = (over: Partial<FileSource> = {}): FileSource => ({
  id: SEED.sources.file,
  orgId: SEED.orgId,
  format: 'text',
  path,
  ...over,
});

function tailer(over: Partial<FileSource> = {}, offsets = memoryOffsets(), clock = { t: 0 }) {
  const got: string[] = [];
  const t = new FileTailer(src(over), {
    offsets,
    onRecords: async (r) => void got.push(...r),
    idleFlushMs: 500,
    now: () => clock.t,
  });
  return { t, got, offsets, clock };
}

describe('FileTailer', () => {
  it('starts at the end of an existing file, then reads appended lines', async () => {
    await writeFile(path, 'old line\n');
    const { t, got } = tailer();
    await t.poll();
    expect(got).toEqual([]);
    await appendFile(path, 'first\nsecond\n');
    await t.poll();
    expect(got).toEqual(['first', 'second']);
  });

  it('waits for the rest of a half-written line', async () => {
    await writeFile(path, '');
    const { t, got } = tailer();
    await t.poll();
    await appendFile(path, 'ERROR half');
    await t.poll();
    expect(got).toEqual([]);
    await appendFile(path, ' done\n');
    await t.poll();
    expect(got).toEqual(['ERROR half done']);
  });

  it('joins stack-trace lines to the record before them (recordStart)', async () => {
    await writeFile(path, '');
    const { t, got, clock } = tailer({ recordStart: '^\\d{4}-\\d{2}-\\d{2}' });
    await t.poll();
    await appendFile(
      path,
      '2026-11-21 ERROR boom\n  at a.b(c.java:1)\n  at d.e(f.java:2)\n2026-11-21 INFO next\n',
    );
    await t.poll();
    // The second record may still get continuation lines: held until the file is quiet.
    expect(got).toEqual(['2026-11-21 ERROR boom\n  at a.b(c.java:1)\n  at d.e(f.java:2)']);
    clock.t += 600;
    await t.poll();
    expect(got.at(-1)).toBe('2026-11-21 INFO next');
  });

  it('keeps the offset of an open record, so a restart re-reads it whole', async () => {
    await writeFile(path, '');
    const first = tailer({ recordStart: '^START' });
    await first.t.poll();
    await appendFile(path, 'START one\nmore\nSTART two\n  cont\n');
    await first.t.poll();
    expect(first.got).toEqual(['START one\nmore']);

    // New process, same Redis offset: "START two" is read again with its continuation.
    await appendFile(path, '  cont2\n');
    const second = tailer({ recordStart: '^START' }, first.offsets, { t: 10_000 });
    await second.t.poll();
    second.clock.t += 600; // quiet: the record is complete
    await second.t.poll();
    expect(second.got).toEqual(['START two\n  cont\n  cont2']);
  });

  it('rotation (new inode) and truncation start again from the top', async () => {
    await writeFile(path, '');
    const { t, got } = tailer();
    await t.poll();
    await appendFile(path, 'a\n');
    await t.poll();

    await rename(path, `${path}.1`);
    await writeFile(path, 'after rotation\n');
    await t.poll();
    expect(got).toEqual(['a', 'after rotation']);

    await truncate(path, 0);
    await appendFile(path, 'x\n');
    await t.poll();
    expect(got.at(-1)).toBe('x');
  });

  it('a missing file is not an error; lines show up once it exists', async () => {
    const { t, got } = tailer();
    await t.poll();
    await writeFile(path, '');
    await t.poll();
    await appendFile(path, 'hello\n');
    await t.poll();
    expect(got).toEqual(['hello']);
  });

  it('stop() during a running poll schedules no further polls', async () => {
    await writeFile(path, '');
    let polls = 0;
    const t = new FileTailer(src(), {
      offsets: memoryOffsets(),
      onRecords: async () => {},
    });
    const poll = t.poll.bind(t);
    t.poll = async () => {
      polls++;
      await new Promise((r) => setTimeout(r, 30));
      return poll();
    };
    t.start(5);
    t.stop(); // first poll is still running
    await new Promise((r) => setTimeout(r, 100));
    expect(polls).toBe(1);
  });

  it('a failed write to the stream re-reads the same lines', async () => {
    await writeFile(path, '');
    let fail = true;
    const got: string[] = [];
    const t = new FileTailer(src(), {
      offsets: memoryOffsets(),
      onRecords: async (r) => {
        if (fail) throw new Error('redis down');
        got.push(...r);
      },
    });
    await t.poll();
    await appendFile(path, 'important\n');
    await expect(t.poll()).rejects.toThrow('redis down');
    fail = false;
    await t.poll();
    expect(got).toEqual(['important']);
  });
});

describe('FileTailManager', () => {
  function memorySink() {
    const streams = new Map<string, string[]>();
    const sink: EventSink = {
      add: async (s, p) => void streams.set(s, [...(streams.get(s) ?? []), ...p]),
      backlog: async (s) => streams.get(s)?.length ?? 0,
    };
    return { sink, streams };
  }

  it('one instance per file (lease), the other takes over when it stops', async () => {
    await writeFile(path, '');
    const leases = memoryLeases();
    const offsets = memoryOffsets();
    const mem = memorySink();
    const make = (owner: string) =>
      new FileTailManager(async () => [src()], leases, offsets, mem.sink, {
        owner,
        root: dir,
        eventStreamShards: 1,
        pollMs: 20,
        validate: true,
      });
    const a = make('a');
    const b = make('b');
    await a.sync();
    await b.sync();
    expect(a.active).toEqual([SEED.sources.file]);
    expect(b.active).toEqual([]);

    await new Promise((r) => setTimeout(r, 60));
    await appendFile(path, '2026-11-21T09:00:00Z WARN [pricing-engine-3] EURUSD slow\n');
    await new Promise((r) => setTimeout(r, 120));
    const payloads = mem.streams.get('stream:events') ?? [];
    expect(payloads).toHaveLength(1);
    expect(Envelope.parse(JSON.parse(payloads[0]!))).toMatchObject({ sourceId: SEED.sources.file });

    await a.stopAll(); // releases the lease
    await b.sync();
    expect(b.active).toEqual([SEED.sources.file]);
    await b.stopAll();
  });

  it('drops a record that cannot become an envelope instead of retrying it forever', async () => {
    const mem = memorySink();
    const m = new FileTailManager(async () => [], memoryLeases(), memoryOffsets(), mem.sink, {
      owner: 'a',
      root: dir,
      eventStreamShards: 1,
      validate: true,
    });
    // An unknown format fails envelope validation.
    await m.handle(src({ format: 'grok' as FileSource['format'] }), ['line']);
    expect(mem.streams.size).toBe(0);
    await m.handle(src(), ['ok line']);
    expect(mem.streams.get('stream:events')).toHaveLength(1);
  });

  it('refuses paths outside FILE_SOURCE_ROOT', async () => {
    const m = new FileTailManager(
      async () => [src({ path: '/etc/passwd' })],
      memoryLeases(),
      memoryOffsets(),
      memorySink().sink,
      {
        owner: 'a',
        root: dir,
        eventStreamShards: 1,
      },
    );
    await m.sync();
    expect(m.active).toEqual([]);
  });
});
