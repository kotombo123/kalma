import { streamFor, type Logger } from '@alerting/config';
import type { ParserOptions, Source } from '@alerting/contracts';
import { and, eq, t, type Db } from '@alerting/db';
import kafkajs, { type Consumer } from 'kafkajs';
import SnappyCodec from 'kafkajs-snappy';
import { messagesTotal, toEnvelopes } from './envelopes.ts';
import type { EventSink } from './sink.ts';

export interface KafkaSource {
  id: string;
  orgId: string;
  format: Source['format'];
  parserOptions?: ParserOptions;
  topic: string;
  brokers?: string[];
  fromBeginning: boolean;
}

// kafkajs is CommonJS: Node's ESM loader cannot see all of its named exports.
const { CompressionCodecs, CompressionTypes, Kafka, logLevel } = kafkajs;

// kafkajs ships gzip only; Snappy is the default of rpk and of many Java producers.
CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec;

export type LoadKafkaSources = () => Promise<KafkaSource[]>;

/** One record value; tombstones (null value) are dropped before this. */
export type OnMessages = (values: string[]) => Promise<void>;

export interface RunningConsumer {
  stop(): Promise<void>;
}

/** Starts consuming one source; resolves once subscribed. Swapped for a fake in unit tests. */
export type StartConsumer = (
  source: KafkaSource,
  onMessages: OnMessages,
  /** Called when the consumer died for good (kafkajs gave up restarting it). */
  onCrash: (err: unknown) => void,
) => Promise<RunningConsumer>;

export const groupIdFor = (sourceId: string) => `alerting-${sourceId}`;

/** Enabled `kafka` sources from Postgres. */
export function dbKafkaSources(db: Db): LoadKafkaSources {
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
      .where(and(eq(t.sources.transport, 'kafka'), eq(t.sources.enabled, true)));
    return rows.flatMap(({ config, ...row }) =>
      config.transport === 'kafka'
        ? [
            {
              ...row,
              format: row.format as Source['format'],
              parserOptions: row.parserOptions ?? undefined,
              topic: config.topic,
              brokers: config.brokers,
              fromBeginning: config.fromBeginning ?? false,
            },
          ]
        : [],
    );
  };
}

/**
 * kafkajs consumer in group `alerting-{sourceId}`: every ingest instance joins the same group,
 * so partitions spread across instances. Offsets are committed only after the batch is in
 * `stream:events` (manual commit), so a crash means redelivery, never loss.
 */
export function kafkajsConsumers(defaultBrokers: string[], log?: Logger): StartConsumer {
  const clients = new Map<string, InstanceType<typeof Kafka>>();
  const clientFor = (brokers: string[]) => {
    const key = brokers.join(',');
    let client = clients.get(key);
    if (!client) {
      client = new Kafka({ clientId: 'alerting-ingest', brokers, logLevel: logLevel.WARN });
      clients.set(key, client);
    }
    return client;
  };

  return async (source, onMessages, onCrash) => {
    const consumer: Consumer = clientFor(source.brokers?.length ? source.brokers : defaultBrokers).consumer({
      groupId: groupIdFor(source.id),
    });
    consumer.on(consumer.events.CRASH, ({ payload }) => {
      if (!payload.restart) onCrash(payload.error);
    });
    await consumer.connect();
    await consumer.subscribe({ topic: source.topic, fromBeginning: source.fromBeginning });
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        const values = batch.messages.flatMap((m) => (m.value ? [m.value.toString('utf8')] : []));
        if (values.length) await onMessages(values);
        const last = batch.messages.at(-1);
        if (!last) return;
        resolveOffset(last.offset);
        await consumer.commitOffsets([
          { topic: batch.topic, partition: batch.partition, offset: (BigInt(last.offset) + 1n).toString() },
        ]);
        await heartbeat();
      },
    });
    log?.info({ sourceId: source.id, topic: source.topic }, 'kafka consumer started');
    return { stop: () => consumer.disconnect() };
  };
}

export interface KafkaManagerOptions {
  eventStreamShards: number;
  validate?: boolean;
  now?: () => number;
  log?: Logger;
}

/**
 * Keeps one consumer per enabled kafka source. `sync()` runs at start, on `config:changed`
 * (kind `sources`) and periodically: new sources start, removed / disabled ones stop, and a
 * changed topic / brokers / format restarts the consumer. Syncs never overlap.
 */
export class KafkaManager {
  private running = new Map<string, { key: string; consumer: RunningConsumer }>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly load: LoadKafkaSources,
    private readonly start: StartConsumer,
    private readonly sink: EventSink,
    private readonly opts: KafkaManagerOptions,
  ) {}

  /** Source ids with a running consumer. */
  get active(): string[] {
    return [...this.running.keys()];
  }

  sync(): Promise<void> {
    this.chain = this.chain
      .then(() => this.doSync())
      .catch((err) => this.opts.log?.error({ err }, 'kafka sync failed'));
    return this.chain;
  }

  async stopAll(): Promise<void> {
    await this.chain;
    await Promise.all([...this.running.values()].map((r) => r.consumer.stop()));
    this.running.clear();
  }

  /** Writes one batch of record values for a source to its `stream:events` shard. */
  async handle(source: KafkaSource, values: string[]): Promise<void> {
    const ingestTs = (this.opts.now ?? Date.now)();
    const payloads = values.flatMap(
      (body) => toEnvelopes(source, body, { ingestTs, validate: this.opts.validate }).payloads,
    );
    if (!payloads.length) return;
    await this.sink.add(streamFor(source.id, this.opts.eventStreamShards), payloads);
    messagesTotal.inc({ source: source.id, transport: 'kafka' }, payloads.length);
  }

  private async doSync(): Promise<void> {
    const wanted = new Map((await this.load()).map((s) => [s.id, s]));

    for (const [id, r] of this.running) {
      const s = wanted.get(id);
      if (!s || keyOf(s) !== r.key) {
        await r.consumer.stop();
        this.running.delete(id);
        this.opts.log?.info({ sourceId: id }, 'kafka consumer stopped');
      }
    }
    for (const [id, s] of wanted) {
      if (this.running.has(id)) continue;
      try {
        const consumer = await this.start(
          s,
          (values) => this.handle(s, values),
          (err) => {
            // Forget it; the next sync (config:changed or the periodic one) starts a fresh consumer.
            this.opts.log?.error({ err, sourceId: id }, 'kafka consumer crashed');
            if (this.running.get(id)?.consumer === consumer) this.running.delete(id);
            void consumer.stop().catch(() => {});
          },
        );
        this.running.set(id, { key: keyOf(s), consumer });
      } catch (err) {
        // Broker down or topic missing: retried on the next sync.
        this.opts.log?.warn({ err, sourceId: id, topic: s.topic }, 'kafka consumer failed to start');
      }
    }
  }
}

const keyOf = (s: KafkaSource) =>
  JSON.stringify([s.topic, s.brokers ?? [], s.fromBeginning, s.format, s.parserOptions ?? null, s.orgId]);
