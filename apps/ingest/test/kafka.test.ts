import { Envelope, SEED } from '@alerting/contracts';
import { readFixture } from '@alerting/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { KafkaManager, type KafkaSource, type OnMessages, type StartConsumer } from '../src/kafka.ts';
import type { EventSink } from '../src/sink.ts';

const source = (over: Partial<KafkaSource> = {}): KafkaSource => ({
  id: SEED.sources.kafka,
  orgId: SEED.orgId,
  format: 'json',
  topic: 'workflow-events',
  fromBeginning: false,
  ...over,
});

/** Fake broker: records started / stopped consumers and lets tests deliver messages. */
function fakeKafka(opts: { failFor?: string[] } = {}) {
  const started: string[] = [];
  const stopped: string[] = [];
  const deliver = new Map<string, OnMessages>();
  const crash = new Map<string, (err: unknown) => void>();
  const start: StartConsumer = async (s, onMessages, onCrash) => {
    crash.set(s.id, onCrash);
    if (opts.failFor?.includes(s.id)) throw new Error('broker down');
    started.push(`${s.id}:${s.topic}`);
    deliver.set(s.id, onMessages);
    return {
      stop: async () => {
        stopped.push(`${s.id}:${s.topic}`);
        deliver.delete(s.id);
      },
    };
  };
  return { start, started, stopped, deliver, crash };
}

function memorySink() {
  const streams = new Map<string, string[]>();
  const sink: EventSink = {
    async add(stream, payloads) {
      streams.set(stream, [...(streams.get(stream) ?? []), ...payloads]);
    },
    async backlog(stream) {
      return streams.get(stream)?.length ?? 0;
    },
  };
  return { sink, streams };
}

describe('KafkaManager', () => {
  it('starts one consumer per enabled kafka source', async () => {
    const k = fakeKafka();
    let sources = [source(), source({ id: 'src-2', topic: 'other' })];
    const m = new KafkaManager(async () => sources, k.start, memorySink().sink, { eventStreamShards: 1 });
    await m.sync();
    expect(k.started).toEqual([`${SEED.sources.kafka}:workflow-events`, 'src-2:other']);
    expect(m.active).toHaveLength(2);

    // Same config on the next sync: nothing restarts.
    await m.sync();
    expect(k.started).toHaveLength(2);

    // Removed (or disabled) source stops; changed topic restarts.
    sources = [source({ topic: 'workflow-events-v2' })];
    await m.sync();
    expect(k.stopped).toEqual([`${SEED.sources.kafka}:workflow-events`, 'src-2:other']);
    expect(k.started.at(-1)).toBe(`${SEED.sources.kafka}:workflow-events-v2`);
    expect(m.active).toEqual([SEED.sources.kafka]);

    await m.stopAll();
    expect(m.active).toEqual([]);
  });

  it('a source whose consumer fails to start is retried on the next sync', async () => {
    const failing = { failFor: [SEED.sources.kafka] };
    const k = fakeKafka(failing);
    const m = new KafkaManager(async () => [source()], k.start, memorySink().sink, { eventStreamShards: 1 });
    await m.sync();
    expect(m.active).toEqual([]);
    failing.failFor = [];
    await m.sync();
    expect(m.active).toEqual([SEED.sources.kafka]);
  });

  it('a consumer that crashed for good is restarted by the next sync', async () => {
    const k = fakeKafka();
    const m = new KafkaManager(async () => [source()], k.start, memorySink().sink, { eventStreamShards: 1 });
    await m.sync();
    k.crash.get(SEED.sources.kafka)!(new Error('Snappy compression not implemented'));
    expect(m.active).toEqual([]);
    await m.sync();
    expect(m.active).toEqual([SEED.sources.kafka]);
    expect(k.started).toHaveLength(2);
  });

  it('concurrent syncs do not start a source twice', async () => {
    const k = fakeKafka();
    const m = new KafkaManager(async () => [source()], k.start, memorySink().sink, { eventStreamShards: 1 });
    await Promise.all([m.sync(), m.sync(), m.sync()]);
    expect(k.started).toHaveLength(1);
  });

  it('messages become envelopes on stream:events, like HTTP ingest', async () => {
    const k = fakeKafka();
    const mem = memorySink();
    const m = new KafkaManager(async () => [source()], k.start, mem.sink, {
      eventStreamShards: 1,
      validate: true,
      now: () => 1_795_000_000_000,
    });
    await m.sync();
    const body = readFixture('events/workflow-failed.json');
    await k.deliver.get(SEED.sources.kafka)!([body, body, '{"broken": ']);

    const payloads = mem.streams.get('stream:events')!;
    expect(payloads).toHaveLength(3);
    const [first, , broken] = payloads.map((d) => Envelope.parse(JSON.parse(d)));
    expect(first).toMatchObject({
      orgId: SEED.orgId,
      sourceId: SEED.sources.kafka,
      ingestTs: 1_795_000_000_000,
      format: 'json',
      raw: { workflowId: 'WF-20261023-00042' },
    });
    expect(broken).toMatchObject({ parseError: true });
  });

  it('a failing sink rejects the batch (so the offset is not committed)', async () => {
    const k = fakeKafka();
    const sink: EventSink = {
      add: async () => {
        throw new Error('redis down');
      },
      backlog: async () => 0,
    };
    const m = new KafkaManager(async () => [source()], k.start, sink, { eventStreamShards: 1 });
    await m.sync();
    await expect(k.deliver.get(SEED.sources.kafka)!(['{"a":1}'])).rejects.toThrow('redis down');
  });
});
