import { hostname } from 'node:os';
import { CONFIG_CHANGED, createLogger, createRedis, env, newId } from '@alerting/config';
import { ConfigChanged } from '@alerting/contracts';
import { createDb } from '@alerting/db';
import { buildApp } from './app.ts';
import { dbFileSources, FileTailManager, redisOffsets } from './file-tail.ts';
import { dbKafkaSources, KafkaManager, kafkajsConsumers } from './kafka.ts';
import { redisLeases } from './lease.ts';
import { dbPollSources, pollManager, redisPollState } from './poll.ts';
import { redisSink } from './sink.ts';
import { dbSourceLoader, SourceCache } from './sources.ts';

const e = env();
const log = createLogger('ingest');
const { db, sql } = createDb();
const redis = createRedis();
const subscriber = redis.duplicate();

const sources = new SourceCache(dbSourceLoader(db));
const sink = redisSink(redis);
const validate = e.NODE_ENV !== 'production';

const kafka = new KafkaManager(dbKafkaSources(db), kafkajsConsumers(e.KAFKA_BROKERS.split(','), log), sink, {
  eventStreamShards: e.EVENT_STREAM_SHARDS,
  validate,
  log,
});

// One instance per file source (lease); the others take over if it stops renewing.
// Lease owner token, unique per process.
const owner = `${hostname()}-${process.pid}-${newId()}`;
const files = new FileTailManager(dbFileSources(db), redisLeases(redis), redisOffsets(redis), sink, {
  owner,
  root: e.FILE_SOURCE_ROOT,
  eventStreamShards: e.EVENT_STREAM_SHARDS,
  validate,
  log,
});

// One instance per poll source, same leases.
const polls = pollManager(dbPollSources(db), redisLeases(redis), redisPollState(redis), sink, {
  owner,
  eventStreamShards: e.EVENT_STREAM_SHARDS,
  validate,
  log,
});

// Key rotation, disabling a source and new / changed Kafka / file sources take effect without restart.
await subscriber.subscribe(CONFIG_CHANGED);
subscriber.on('message', (_channel, message) => {
  const parsed = ConfigChanged.safeParse(JSON.parse(message));
  if (!parsed.success || parsed.data.kind !== 'sources') return;
  sources.invalidate(parsed.data.id);
  void kafka.sync();
  void files.sync();
  void polls.sync();
});
// Backstop for a missed notification or a broker that was down at start.
const kafkaTimer = setInterval(() => void kafka.sync(), 30_000);
// Renews file / poll leases (TTL 15 s) and picks up sources whose holder died.
const leaseTimer = setInterval(() => void Promise.all([files.sync(), polls.sync()]), 5_000);

const app = await buildApp(
  {
    sources,
    sink,
    config: { eventStreamShards: e.EVENT_STREAM_SHARDS, validate },
  },
  { loggerInstance: log },
);

await app.listen({ host: '0.0.0.0', port: e.INGEST_PORT });
void kafka.sync();
void files.sync();
void polls.sync();
log.info({ port: e.INGEST_PORT }, 'ready');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearInterval(kafkaTimer);
    clearInterval(leaseTimer);
    void app
      .close()
      .then(() => Promise.all([kafka.stopAll(), files.stopAll(), polls.stopAll()]))
      .then(() => Promise.all([sql.end(), redis.quit(), subscriber.quit()]))
      .then(() => process.exit(0));
  });
}
