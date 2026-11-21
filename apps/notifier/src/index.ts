import { createLogger, createRedis, startMetricsServer, env } from '@alerting/config';
import { createDb } from '@alerting/db';
import { createTelegramAdapter } from '@alerting/channels';
import { runConsumer } from './consumer.ts';
import { runDispatcher } from './dispatcher.ts';
import { runEscalationLoop } from './escalation.ts';
import { buildInboundHandler } from './telegram-inbound.ts';
import { runStepEngine } from './step-engine.ts';
import { runSweeper } from './sweeper.ts';
import { runDigestFlusher } from './digest-flusher.ts';

async function start(): Promise<void> {
  const e = env();
  const log = createLogger('notifier');
  const { db } = createDb();
  const redis = createRedis();

  startMetricsServer(e.METRICS_PORT);

  // Wire up Telegram inbound (link codes + ACK/Approve/Reject)
  if (e.TELEGRAM_BOT_TOKEN) {
    const tgAdapter = createTelegramAdapter({ botToken: e.TELEGRAM_BOT_TOKEN });
    if (tgAdapter.startInbound) {
      await tgAdapter.startInbound(buildInboundHandler(db, redis, log));
    }
  }

  log.info('ready');

  await Promise.all([
    runConsumer(redis, db, log),
    runDispatcher(db, e, log),
    runEscalationLoop(db, log),
    runStepEngine(db, log),
    runSweeper(db, redis, log),
    runDigestFlusher(db, redis, log),
  ]);
}

start().catch((err) => {
  console.error('[notifier] fatal', err);
  process.exit(1);
});
