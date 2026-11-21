import { eventStreams, GROUP_WORKERS, type Logger, type Redis } from '@alerting/config';

export interface ConsumerOptions {
  consumer: string;
  shards: number;
  batchSize?: number;
  blockMs?: number;
  /** Messages pending longer than this on a dead consumer are taken over. */
  claimIdleMs?: number;
  log?: Logger;
}

type StreamReply = [stream: string, entries: [id: string, fields: string[]][]][];

const payloadOf = (fields: string[]) => {
  const i = fields.indexOf('d');
  return i >= 0 ? fields[i + 1] : undefined;
};

/**
 * Reads `stream:events` (all shards) through consumer group `workers`. Each batch goes to
 * `handle`; it is XACKed only if `handle` resolves, so a crash or DB error means redelivery
 * (to this consumer on restart, or to another one via XAUTOCLAIM).
 */
export class EventConsumer {
  private running = false;
  private loop?: Promise<void>;
  private readonly streams: string[];

  constructor(
    private readonly redis: Redis,
    private readonly handle: (payloads: string[]) => Promise<void>,
    private readonly opts: ConsumerOptions,
  ) {
    this.streams = eventStreams(opts.shards);
  }

  async start(): Promise<void> {
    await this.ensureGroups();
    this.running = true;
    this.loop = this.run();
  }

  /** Creates the consumer group on every shard (idempotent). `start()` does this first. */
  async ensureGroups(): Promise<void> {
    for (const stream of this.streams) {
      try {
        await this.redis.xgroup('CREATE', stream, GROUP_WORKERS, '0', 'MKSTREAM');
      } catch (e) {
        if (!String(e).includes('BUSYGROUP')) throw e;
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /** One read + handle + ack cycle. Exposed for tests. */
  async tick(): Promise<number> {
    const reply = (await this.redis.xreadgroup(
      'GROUP',
      GROUP_WORKERS,
      this.opts.consumer,
      'COUNT',
      this.opts.batchSize ?? 500,
      'BLOCK',
      this.opts.blockMs ?? 50,
      'STREAMS',
      ...this.streams,
      ...this.streams.map(() => '>'),
    )) as StreamReply | null;
    if (!reply) return 0;
    let n = 0;
    for (const [stream, entries] of reply) n += await this.process(stream, entries);
    return n;
  }

  /** Takes over messages idle on other (dead) consumers. */
  async claimAbandoned(): Promise<number> {
    let n = 0;
    for (const stream of this.streams) {
      const [, entries] = (await this.redis.xautoclaim(
        stream,
        GROUP_WORKERS,
        this.opts.consumer,
        this.opts.claimIdleMs ?? 30_000,
        '0',
        'COUNT',
        this.opts.batchSize ?? 500,
      )) as [string, [string, string[]][]];
      if (entries.length) n += await this.process(stream, entries);
    }
    return n;
  }

  private async process(stream: string, entries: [string, string[]][]): Promise<number> {
    const live = entries.filter(([, fields]) => fields); // XAUTOCLAIM can return deleted entries as null
    const payloads = live.map(([, fields]) => payloadOf(fields)).filter((d): d is string => d !== undefined);
    await this.handle(payloads);
    if (entries.length) await this.redis.xack(stream, GROUP_WORKERS, ...entries.map(([id]) => id));
    return payloads.length;
  }

  private async run(): Promise<void> {
    let lastClaim = Date.now();
    while (this.running) {
      try {
        await this.tick();
        if (Date.now() - lastClaim > (this.opts.claimIdleMs ?? 30_000)) {
          lastClaim = Date.now();
          await this.claimAbandoned();
        }
      } catch (e) {
        this.opts.log?.error({ err: e }, 'batch failed, will be redelivered');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}
