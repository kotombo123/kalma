import { metrics, newId, prom } from '@alerting/config';
import { Envelope } from '@alerting/contracts';
import { parse } from '@alerting/parsing';
import type { IngestSource } from './sources.ts';

const RAW_TEXT_LIMIT = 16 * 1024;

export const messagesTotal = new prom.Counter({
  name: 'ingest_messages_total',
  help: 'Events accepted by ingest',
  labelNames: ['source', 'transport'] as const,
  registers: [metrics()],
});
export const rejectedTotal = new prom.Counter({
  name: 'ingest_rejected_total',
  help: 'Requests rejected by ingest',
  labelNames: ['reason'] as const,
  registers: [metrics()],
});

/**
 * One received payload (HTTP body, Kafka message, file record, polled item) → `stream:events`
 * entries: parsed into records, each wrapped in an Envelope (JSON for field `d`).
 */
export function toEnvelopes(
  source: Pick<IngestSource, 'id' | 'orgId' | 'format' | 'parserOptions'>,
  body: string,
  opts: { contentType?: string; ingestTs: number; validate?: boolean },
): { payloads: string[]; parseError: boolean } {
  const result = parse({
    body,
    format: source.format,
    contentType: opts.contentType,
    parserOptions: source.parserOptions,
  });
  const receivedAt = new Date(opts.ingestTs).toISOString();
  // The original text is kept only when it is this one event (or unparseable).
  const rawText = result.records.length === 1 ? body.slice(0, RAW_TEXT_LIMIT) : undefined;

  const payloads = result.records.map((raw) => {
    const envelope: Envelope = {
      id: newId(),
      orgId: source.orgId,
      sourceId: source.id,
      receivedAt,
      ingestTs: opts.ingestTs,
      format: result.format,
      raw,
      ...(rawText !== undefined && { rawText }),
      ...(result.parseError && { parseError: true }),
    };
    return JSON.stringify(opts.validate ? Envelope.parse(envelope) : envelope);
  });
  return { payloads, parseError: result.parseError };
}
