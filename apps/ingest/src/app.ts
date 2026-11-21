import { metrics, streamFor } from '@alerting/config';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { messagesTotal, rejectedTotal, toEnvelopes } from './envelopes.ts';
import type { EventSink } from './sink.ts';
import { keyMatches, type SourceCache } from './sources.ts';

export interface IngestConfig {
  /** Request body limit in bytes. */
  bodyLimit: number;
  /** Above this many entries not yet read by the workers, ingest answers 503 + Retry-After. */
  backpressureLength: number;
  /** How often the backlog is re-read for backpressure. */
  backpressureCheckMs: number;
  eventStreamShards: number;
  /** Validate every envelope with Zod before XADD (dev / test). */
  validate: boolean;
}

export const DEFAULT_CONFIG: IngestConfig = {
  bodyLimit: 1024 * 1024,
  backpressureLength: 500_000,
  backpressureCheckMs: 500,
  eventStreamShards: 1,
  validate: false,
};

export interface IngestDeps {
  sources: SourceCache;
  sink: EventSink;
  config?: Partial<IngestConfig>;
  /** Clock, for tests. */
  now?: () => number;
}

export async function buildApp(deps: IngestDeps, opts: FastifyServerOptions = {}) {
  const config = { ...DEFAULT_CONFIG, ...deps.config };
  const now = deps.now ?? Date.now;
  const app = Fastify({ bodyLimit: config.bodyLimit, ...opts });

  // Every body arrives as text: format detection and parsing are ours, not Fastify's.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  // Backpressure: one backlog read per stream per interval, not one per request.
  const lengths = new Map<string, { value: number; at: number }>();
  const streamLength = async (stream: string) => {
    const cached = lengths.get(stream);
    if (cached && now() - cached.at < config.backpressureCheckMs) return cached.value;
    const value = await deps.sink.backlog(stream);
    lengths.set(stream, { value, at: now() });
    return value;
  };

  app.get('/health', async () => 'ok');
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics().contentType);
    return metrics().metrics();
  });

  app.post<{ Params: { sourceId: string }; Querystring: { key?: string } }>(
    '/ingest/:sourceId',
    async (req, reply) => {
      const reject = (status: number, code: string, message: string) => {
        rejectedTotal.inc({ reason: code });
        return reply.status(status).send({ error: { code, message } });
      };

      const key = req.headers['x-api-key'] ?? req.query.key;
      if (typeof key !== 'string' || key === '')
        return reject(401, 'missing_api_key', 'X-Api-Key header or ?key= is required');

      const source = await deps.sources.get(req.params.sourceId);
      // Same answer for unknown source and wrong key: do not reveal which source ids exist.
      if (!source || !keyMatches(key, source.apiKeyHash))
        return reject(401, 'invalid_api_key', 'Unknown source or wrong API key');
      if (!source.enabled) return reject(403, 'source_disabled', 'Source is disabled');

      const stream = streamFor(source.id, config.eventStreamShards);
      if ((await streamLength(stream)) > config.backpressureLength) {
        reply.header('retry-after', '1');
        return reject(503, 'backpressure', 'Event stream is full, retry shortly');
      }

      const body = typeof req.body === 'string' ? req.body : '';
      if (body.trim() === '') return reject(400, 'empty_body', 'Request body is empty');

      const { payloads, parseError } = toEnvelopes(source, body, {
        contentType: req.headers['content-type'],
        ingestTs: now(),
        validate: config.validate,
      });

      await deps.sink.add(stream, payloads);
      messagesTotal.inc({ source: source.id, transport: 'http' }, payloads.length);
      return reply.status(202).send({ accepted: payloads.length, parseError });
    },
  );

  return app;
}
