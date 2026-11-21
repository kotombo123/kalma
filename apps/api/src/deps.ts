import type { Redis } from '@alerting/config';
import type { Db } from '@alerting/db';
import type { Mailer } from './lib/mailer.ts';
import type { ConnectorSync } from './connectors/sync.ts';

export interface AppConfig {
  jwtSecret: string;
  /** Base URL of the web UI (links in emails). */
  publicUrl: string;
  /** Enables /dev/* routes (NODE_ENV=development only). */
  devRoutes: boolean;
  /** Secure cookies (HTTPS). */
  secureCookies: boolean;
  /** Turn off for unit tests that hammer endpoints. */
  rateLimit: boolean;
  /** Ingest URL as seen by source systems (connect instructions). */
  ingestPublicUrl: string;
  /** Kafka brokers shown in connect instructions. */
  kafkaBrokers: string;
  /** File sources must be under this directory. */
  fileSourceRoot: string;
  /** Internal URLs probed by GET /system/status, and public links shown next to them. */
  system?: {
    ingestUrl: string;
    demoSystemsUrl: string;
    prometheusUrl: string;
    links: { grafana: string; mailpit: string; redpandaConsole: string; apiDocs: string };
  };
}

export interface Deps {
  db: Db;
  redis: Redis;
  mailer: Mailer;
  config: AppConfig;
  /** Connector files sync (#46); absent in tests. */
  connectors?: ConnectorSync;
}
