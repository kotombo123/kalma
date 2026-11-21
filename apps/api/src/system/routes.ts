/**
 * F-21 — System page: health of every part of the pipeline, queue backlog, throughput.
 * Read-only and cheap; probes time out quickly so one dead service never stalls the page.
 */
import type { FastifyInstance } from 'fastify';
import { STREAM_ALERTS, STREAM_EVENTS } from '@alerting/config';
import { sql } from '@alerting/db';
import type { Deps } from '../deps.ts';
import { requireAuth } from '../auth/guards.ts';

const PROBE_MS = 1500;
type Health = { name: string; ok: boolean; detail: string };

async function probe(name: string, fn: () => Promise<string>): Promise<Health> {
  try {
    const detail = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PROBE_MS)),
    ]);
    return { name, ok: true, detail };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message };
  }
}

async function httpOk(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return 'odpowiada';
}

/** Consumer groups of a stream: consumers, pending and lag (Redis XINFO GROUPS). */
function parseGroups(
  raw: unknown,
): { name: string; consumers: number; pending: number; lag: number | null }[] {
  return (raw as unknown[][]).map((fields) => {
    const m = new Map<string, unknown>();
    for (let i = 0; i < fields.length; i += 2) m.set(String(fields[i]), fields[i + 1]);
    return {
      name: String(m.get('name')),
      consumers: Number(m.get('consumers') ?? 0),
      pending: Number(m.get('pending') ?? 0),
      lag: m.get('lag') === null || m.get('lag') === undefined ? null : Number(m.get('lag')),
    };
  });
}

export async function statusRoutes(app: FastifyInstance, { db, redis, config }: Deps) {
  const sys = config.system;

  async function rate(query: string): Promise<number | null> {
    if (!sys) return null;
    try {
      const res = await fetch(`${sys.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(PROBE_MS),
      });
      const body = (await res.json()) as { data?: { result?: { value: [number, string] }[] } };
      const v = body.data?.result?.[0]?.value[1];
      return v === undefined ? 0 : Math.round(Number(v) * 10) / 10;
    } catch {
      return null;
    }
  }

  app.get('/system/status', { preHandler: requireAuth, schema: { tags: ['system'] } }, async (req) => {
    const streams = await Promise.all(
      [STREAM_EVENTS, STREAM_ALERTS].map(async (stream) => {
        const length = await redis.xlen(stream).catch(() => 0);
        const groups = await redis
          .xinfo('GROUPS', stream)
          .then(parseGroups)
          .catch(() => []);
        return { stream, length, groups };
      }),
    );
    const consumers = (s: string) =>
      streams.find((x) => x.stream === s)?.groups.reduce((n, g) => n + g.consumers, 0) ?? 0;

    const services: Health[] = await Promise.all([
      probe('Baza danych (Postgres)', async () => {
        await db.execute(sql`select 1`);
        return 'odpowiada';
      }),
      probe('Redis', async () => `${await redis.ping()}`.toLowerCase()),
      probe(
        'API',
        async () => `${app.hub.connections(req.user.orgId)} połączeń na żywo z Twojej organizacji`,
      ),
      ...(sys
        ? [
            probe('Ingest', () => httpOk(`${sys.ingestUrl}/health`)),
            probe('Demo-systems', () => httpOk(`${sys.demoSystemsUrl}/health`)),
          ]
        : []),
      probe('Worker', async () => {
        const n = consumers(STREAM_EVENTS);
        if (!n) throw new Error('brak konsumentów strumienia zdarzeń');
        return `${n} konsument(ów)`;
      }),
      probe('Notifier', async () => {
        const n = consumers(STREAM_ALERTS);
        if (!n) throw new Error('brak konsumentów strumienia alertów');
        return `${n} konsument(ów)`;
      }),
    ]);

    const [ingestPerSec, eventsPerSec, deliveriesPerSec] = await Promise.all([
      rate('sum(rate(ingest_messages_total[1m]))'),
      rate('sum(rate(worker_events_total[1m]))'),
      rate('sum(rate(deliveries_total[1m]))'),
    ]);

    return {
      services,
      streams,
      throughput: { ingestPerSec, eventsPerSec, deliveriesPerSec },
      links: sys?.links ?? null,
    };
  });
}
