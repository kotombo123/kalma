/**
 * B1-17: Kafka load generator for the seed Kafka source (topic `workflow-events`).
 *   tsx loadtest/kafka-producer.ts [--rate 10000] [--duration 60] [--batch 500] [--brokers localhost:19092]
 * Same mix as http.js: 70% duplicates (50 hot workflow ids), 25% unique WORKFLOW_FAILED events
 * matching the Settlements rule, 5% unknown shapes. Prints messages sent per second.
 */
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type * as KafkaJs from 'kafkajs';

// kafkajs is a dependency of apps/ingest; loadtest/ is not a workspace package.
const { Kafka, logLevel, CompressionTypes } = createRequire(
  new URL('../apps/ingest/package.json', import.meta.url),
)('kafkajs') as typeof KafkaJs;

const { values: a } = parseArgs({
  options: {
    rate: { type: 'string', default: '10000' },
    duration: { type: 'string', default: '60' },
    batch: { type: 'string', default: '500' },
    topic: { type: 'string', default: 'workflow-events' },
    brokers: { type: 'string', default: process.env.KAFKA_BROKERS ?? 'localhost:19092' },
  },
});
const rate = Number(a.rate);
const durationSec = Number(a.duration);
const batch = Number(a.batch);
const run = Date.now();

let seq = 0;
function event(): string {
  const r = Math.random() * 100;
  if (r < 5) {
    const n = Math.floor(Math.random() * 10);
    return JSON.stringify({ [`kevt_${n}`]: 'load.unknown', node: `k-${n}`, v: Math.random() });
  }
  const workflowId = r < 75 ? `LT-${run}-HOT-${Math.floor(Math.random() * 50)}` : `LT-${run}-${seq++}`;
  return JSON.stringify({
    type: 'WORKFLOW_FAILED',
    workflowId,
    workflowName: 'order-settlement',
    step: 'validate-counterparty',
    severity: 'ERROR',
    environment: 'prod',
    timestamp: new Date().toISOString(),
    error: { code: 'TIMEOUT', message: 'Counterparty service did not respond in 5000 ms' },
  });
}

const kafka = new Kafka({ clientId: 'loadtest', brokers: a.brokers!.split(','), logLevel: logLevel.WARN });
const producer = kafka.producer({ allowAutoTopicCreation: true });
await producer.connect();

const start = Date.now();
let sent = 0;
let lastReport = start;
let lastSent = 0;
while (Date.now() - start < durationSec * 1000) {
  // Keep to the target rate: send when behind schedule, otherwise wait a little.
  const due = Math.floor(((Date.now() - start) / 1000) * rate);
  if (sent >= due) {
    await new Promise((r) => setTimeout(r, 5));
    continue;
  }
  const n = Math.min(batch, due - sent);
  await producer.send({
    topic: a.topic!,
    compression: CompressionTypes.None,
    messages: Array.from({ length: n }, () => ({ value: event() })),
  });
  sent += n;
  if (Date.now() - lastReport >= 5000) {
    console.log(`${Math.round(((sent - lastSent) * 1000) / (Date.now() - lastReport))} msg/s`);
    lastReport = Date.now();
    lastSent = sent;
  }
}
await producer.disconnect();
const secs = (Date.now() - start) / 1000;
console.log(`sent ${sent} messages in ${secs.toFixed(1)} s (${Math.round(sent / secs)} msg/s)`);
