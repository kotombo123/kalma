import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_CHANGED,
  createLogger,
  createRedis,
  env,
  metrics,
  newId,
  prom,
  startMetricsServer,
} from '@alerting/config';
import { ConfigChanged } from '@alerting/contracts';
import { createDb } from '@alerting/db';
import { DbAlerts, redisRecentEvents } from './alerts.ts';
import { EventConsumer } from './consumer.ts';
import { redisDedup } from './dedup.ts';
import { processBatch } from './pipeline.ts';
import { DbRules } from './rules.ts';
import { repoRoot, RULES_DIR, RulesSync, RulesWatcher } from './rules-sync.ts';
import { DbSchemas } from './schemas.ts';
import { registerStreamMetrics } from './stream-metrics.ts';

const e = env();
const log = createLogger('worker');
const validate = e.NODE_ENV !== 'production';
const { db, sql } = createDb();
const redis = createRedis();
const reader = redis.duplicate(); // XREADGROUP BLOCK holds its connection
const subscriber = redis.duplicate();

const eventsTotal = new prom.Counter({
  name: 'worker_events_total',
  help: 'Events processed by the worker',
  labelNames: ['result'] as const,
  registers: [metrics()],
});
const latency = new prom.Histogram({
  name: 'pipeline_latency_ms',
  help: 'Milliseconds since ingest: event read by the worker / alert written',
  labelNames: ['stage'] as const,
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [metrics()],
});

registerStreamMetrics(redis, e.EVENT_STREAM_SHARDS);

const schemas = new DbSchemas(db, redis, log);
const rules = new DbRules(db, log);
const alerts = new DbAlerts(db, redis, { validate, log });
await rules.reload();

// B1-15: config/rules/*.yaml → rules, in the instance holding lease:rules-sync.
const rulesDir = join(repoRoot(), RULES_DIR);
const rulesWatcher = new RulesWatcher(new RulesSync(db, redis, rulesDir, log), redis, rulesDir, {
  owner: `${hostname()}-${process.pid}-${newId()}`,
  log,
});
rulesWatcher.start();

const consumer = new EventConsumer(
  reader,
  async (payloads) => {
    const s = await processBatch(payloads, {
      schemas,
      rules,
      dedup: redisDedup(redis),
      alerts,
      recent: redisRecentEvents(redis, { validate }),
      onLatency: (stage, ms) => latency.observe({ stage }, ms),
    });
    eventsTotal.inc({ result: 'created' }, s.created);
    eventsTotal.inc({ result: 'deduplicated' }, s.deduplicated);
    eventsTotal.inc({ result: 'unmatched' }, s.unmatched);
    eventsTotal.inc({ result: 'invalid' }, s.invalid);
    eventsTotal.inc({ result: 'resolved' }, s.resolved);
  },
  { consumer: `${hostname()}-${process.pid}`, shards: e.EVENT_STREAM_SHARDS, log },
);

// Hot reload: rules engines are swapped, schema / mapping cache entries dropped.
let reloadTimer: NodeJS.Timeout | undefined;
await subscriber.subscribe(CONFIG_CHANGED);
subscriber.on('message', (_channel, message) => {
  const parsed = ConfigChanged.safeParse(JSON.parse(message));
  if (!parsed.success) return;
  const { kind, id } = parsed.data;
  if (kind === 'rules') {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(
      () => void rules.reload().catch((err) => log.error({ err }, 'rules reload failed')),
      100,
    );
  } else if (kind === 'mappings' || kind === 'schemas') {
    schemas.invalidate(id);
  }
});

const flushTimer = setInterval(() => {
  void Promise.all([alerts.flush(), schemas.flush()]).catch((err) => log.error({ err }, 'flush failed'));
}, 1000);

// Under `pnpm dev` the notifier may hold METRICS_PORT; Prometheus also scrapes the next port.
const metricsServer = startMetricsServer(e.METRICS_PORT);
metricsServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') throw err;
  startMetricsServer(e.METRICS_PORT + 1);
  log.info({ port: e.METRICS_PORT + 1 }, 'metrics port taken, using the next one');
});
await consumer.start();
log.info({ consumer: `${hostname()}-${process.pid}` }, 'ready');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearInterval(flushTimer);
    void rulesWatcher.stop();
    void consumer
      .stop()
      .then(() => Promise.all([alerts.flush(), schemas.flush()]))
      .then(() => Promise.all([sql.end(), redis.quit(), reader.quit(), subscriber.quit()]))
      .then(() => process.exit(0));
  });
}
