import { createLogger, createRedis, env } from '@alerting/config';
import { createDb } from '@alerting/db';
import { buildApp } from './app.ts';
import { smtpMailer } from './lib/mailer.ts';
import { ConnectorSync } from './connectors/sync.ts';

const e = env();
const log = createLogger('api');
const { db, sql } = createDb();
const redis = createRedis();
// connector files (config/connectors/) → sources + collector configs (#46)
const connectors = new ConnectorSync(db, redis, {
  outDir: e.COLLECTOR_CONFIG_DIR,
  ingestUrl: e.COLLECTOR_INGEST_URL,
  ports: e.COLLECTOR_PORTS,
  allowedSources: e.COLLECTOR_ALLOWED_SOURCES,
  log: createLogger('connectors'),
});

const app = await buildApp(
  {
    db,
    redis,
    mailer: smtpMailer(),
    connectors,
    config: {
      jwtSecret: e.JWT_SECRET,
      publicUrl: e.PUBLIC_URL,
      devRoutes: e.NODE_ENV === 'development',
      secureCookies: e.PUBLIC_URL.startsWith('https://'),
      rateLimit: true,
      ingestPublicUrl: e.INGEST_PUBLIC_URL,
      kafkaBrokers: e.KAFKA_BROKERS,
      fileSourceRoot: e.FILE_SOURCE_ROOT,
      system: {
        ingestUrl: e.INGEST_URL,
        demoSystemsUrl: e.DEMO_SYSTEMS_URL,
        prometheusUrl: e.PROMETHEUS_URL,
        links: {
          grafana: e.GRAFANA_PUBLIC_URL,
          mailpit: e.MAILPIT_PUBLIC_URL,
          redpandaConsole: e.REDPANDA_CONSOLE_PUBLIC_URL,
          apiDocs: `${e.API_PUBLIC_URL}/docs`,
        },
      },
    },
  },
  { loggerInstance: log },
);

await app.listen({ host: '0.0.0.0', port: e.API_PORT });
log.info({ port: e.API_PORT }, 'ready');
connectors.start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void connectors
      .stop()
      .then(() => app.close())
      .then(() => Promise.all([sql.end(), redis.quit()]))
      .then(() => process.exit(0));
  });
}
