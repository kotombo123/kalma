import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

export const DEV_JWT_SECRET = 'dev-secret-change-me-please';

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    DATABASE_URL: z.string().default('postgres://alerting:alerting@localhost:5432/alerting'),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    KAFKA_BROKERS: z.string().default('localhost:19092'),
    SMTP_HOST: z.string().default('localhost'),
    SMTP_PORT: z.coerce.number().default(1025),
    SMTP_FROM: z.string().default('alerts@acme.test'),
    JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
    PUBLIC_URL: z.string().default('http://localhost:5173'),
    API_URL: z.string().default('http://localhost:3000'),
    INGEST_URL: z.string().default('http://localhost:3001'),
    /** Ingest URL as seen by source systems (shown in "connect" instructions). */
    INGEST_PUBLIC_URL: z.string().default('http://localhost:3001'),
    /** File sources may only tail files under this directory (no path traversal). */
    FILE_SOURCE_ROOT: z.string().default('/var/log'),
    DEMO_SYSTEMS_URL: z.string().default('http://localhost:3002'),
    /** Prometheus HTTP API (throughput on the System page). */
    PROMETHEUS_URL: z.string().default('http://localhost:9090'),
    /** Links shown on the System page (as seen from the browser). */
    GRAFANA_PUBLIC_URL: z.string().default('http://localhost:3003'),
    MAILPIT_PUBLIC_URL: z.string().default('http://localhost:8025'),
    REDPANDA_CONSOLE_PUBLIC_URL: z.string().default('http://localhost:8080'),
    API_PUBLIC_URL: z.string().default('http://localhost:3000'),
    API_PORT: z.coerce.number().default(3000),
    INGEST_PORT: z.coerce.number().default(3001),
    DEMO_SYSTEMS_PORT: z.coerce.number().default(3002),
    METRICS_PORT: z.coerce.number().default(9100),
    EVENT_STREAM_SHARDS: z.coerce.number().int().min(1).default(1),
    /** Connectors (config/connectors/): where generated collector configs go, relative to the repo root */
    COLLECTOR_CONFIG_DIR: z.string().default('collector/generated'),
    /** Ingest URL as seen from the collector (it runs with host networking in dev) */
    COLLECTOR_INGEST_URL: z.string().default('http://localhost:3001'),
    /** Ports connector sources may listen on, e.g. 5514-5530 */
    COLLECTOR_PORTS: z.string().default('5514-5530'),
    /** Vector source types a connector file may use (no `exec`, no `file`) */
    COLLECTOR_ALLOWED_SOURCES: z
      .string()
      .default(
        'syslog,socket,journald,amqp,nats,redis,kafka,kubernetes_logs,docker_logs,aws_sqs,aws_s3,gcp_pubsub,opentelemetry,http_server,demo_logs',
      ),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TEAMS_WEBHOOK_URL: z.string().optional(),
    FEATURE_AI: bool,
  })
  .refine((e) => e.NODE_ENV !== 'production' || e.JWT_SECRET !== DEV_JWT_SECRET, {
    message: 'JWT_SECRET must be set in production',
    path: ['JWT_SECRET'],
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Repo-root `.env`; Docker passes the same values through compose, so the file is only for apps on the host. */
const ROOT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

/** Loads the root `.env` once. Variables already set in the process win; tests never read it. */
function loadRootEnvFile(): void {
  if (process.env.VITEST || !existsSync(ROOT_ENV_FILE)) return;
  process.loadEnvFile(ROOT_ENV_FILE);
}

/** Validated env. Throws on invalid values. Empty strings count as "not set". */
export function env(): Env {
  if (!cached) {
    loadRootEnvFile();
    const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
    cached = EnvSchema.parse(raw);
  }
  return cached;
}
