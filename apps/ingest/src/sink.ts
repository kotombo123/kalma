import { GROUP_WORKERS, type Redis } from '@alerting/config';

/** Where envelopes go. Redis Streams in production; an array in unit tests. */
export interface EventSink {
  /** Appends JSON payloads (field `d`) to a stream in one round trip. */
  add(stream: string, payloads: string[]): Promise<void>;
  /** Entries the workers have not read yet (what backpressure is about, not the stream length). */
  backlog(stream: string): Promise<number>;
}

/** `XADD <stream> MAXLEN ~ <max> * d <json>` per payload, pipelined. */
export function redisSink(redis: Redis, maxLen = 1_000_000): EventSink {
  return {
    async add(stream, payloads) {
      const pipeline = redis.pipeline();
      for (const d of payloads) pipeline.xadd(stream, 'MAXLEN', '~', maxLen, '*', 'd', d);
      const results = await pipeline.exec();
      const failed = results?.find(([error]) => error);
      if (failed) throw failed[0];
    },
    async backlog(stream) {
      // XINFO GROUPS `lag` (Redis 7); null after trimming or deletes, then: length - entries-read.
      try {
        const groups = (await redis.xinfo('GROUPS', stream)) as unknown[][];
        for (const g of groups) {
          const f: Record<string, unknown> = {};
          for (let i = 0; i + 1 < g.length; i += 2) f[String(g[i])] = g[i + 1];
          if (f.name !== GROUP_WORKERS) continue;
          if (f.lag !== null && f.lag !== undefined) return Number(f.lag);
          return Math.max(0, (await redis.xlen(stream)) - Number(f['entries-read'] ?? 0));
        }
      } catch {
        // No stream yet.
      }
      // No worker group yet: everything in the stream is waiting.
      return redis.xlen(stream);
    },
  };
}
