import {
  eventStreams,
  GROUP_NOTIFIERS,
  GROUP_WORKERS,
  metrics,
  prom,
  STREAM_ALERTS,
  type Redis,
} from '@alerting/config';

/** Per stream: entries waiting for the group (`lag`) and handed out but not yet acked (`pending`). */
export interface GroupInfo {
  stream: string;
  group: string;
  length: number;
  lag: number;
  pending: number;
}

/** XLEN + XINFO GROUPS for the event shards (workers) and `stream:alerts` (notifiers). */
export async function readStreams(redis: Redis, shards: number): Promise<GroupInfo[]> {
  const targets = [
    ...eventStreams(shards).map((stream) => ({ stream, group: GROUP_WORKERS })),
    { stream: STREAM_ALERTS, group: GROUP_NOTIFIERS },
  ];
  return Promise.all(
    targets.map(async ({ stream, group }) => {
      const length = await redis.xlen(stream);
      let lag = 0;
      let pending = 0;
      try {
        const groups = (await redis.xinfo('GROUPS', stream)) as unknown[][];
        for (const g of groups) {
          const f = fields(g);
          if (f.name !== group) continue;
          pending = Number(f.pending ?? 0);
          // `lag` is null when Redis cannot tell (after XDEL / trimming): fall back to the length.
          lag = f.lag === null || f.lag === undefined ? length : Number(f.lag);
        }
      } catch {
        // No stream / group yet.
        lag = length;
      }
      return { stream, group, length, lag, pending };
    }),
  );
}

const fields = (flat: unknown[]) => {
  const o: Record<string, unknown> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) o[String(flat[i])] = flat[i + 1];
  return o;
};

/** Gauges read from Redis on every Prometheus scrape. */
export function registerStreamMetrics(redis: Redis, shards: number): void {
  let last: Promise<GroupInfo[]> | undefined;
  // One Redis round per scrape, shared by the three gauges.
  const read = () =>
    (last ??= readStreams(redis, shards).finally(() => setTimeout(() => (last = undefined), 1000)));
  const gauge = (name: string, help: string, pick: (g: GroupInfo) => number) =>
    new prom.Gauge({
      name,
      help,
      labelNames: ['stream', 'group'] as const,
      registers: [metrics()],
      async collect() {
        for (const g of await read()) this.set({ stream: g.stream, group: g.group }, pick(g));
      },
    });
  gauge('stream_length', 'Entries in the Redis stream', (g) => g.length);
  gauge('stream_group_lag', 'Entries the consumer group has not read yet', (g) => g.lag);
  gauge('stream_group_pending', 'Entries read by the group but not acknowledged', (g) => g.pending);
}
