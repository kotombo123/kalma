/**
 * B2-05 sweeper: re-enqueues alerts that have status='open' and dispatched_at IS NULL
 * after SWEEP_AFTER_MS, protecting against loss between worker XADD and consumer dispatch.
 * Runs every POLL_INTERVAL_MS on a simple timer loop.
 */
import type { Logger } from '@alerting/config';
import { sweeperRequeued } from './notifier-metrics.ts';
import { STREAM_ALERTS } from '@alerting/config';
import type { Redis } from '@alerting/config';
import { type Db, t, isNull, lte, eq, and, sql } from '@alerting/db';

const SWEEP_AFTER_MS = 30_000;
const POLL_INTERVAL_MS = 10_000;
const BATCH = 100;

export async function runSweeper(db: Db, redis: Redis, log: Logger): Promise<void> {
  log.info('sweeper started');
  for (;;) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      await sweep(db, redis, log);
    } catch (err) {
      log.error({ err }, 'sweeper error');
    }
  }
}

async function sweep(db: Db, redis: Redis, log: Logger): Promise<void> {
  const cutoff = new Date(Date.now() - SWEEP_AFTER_MS).toISOString();

  const stale = await db
    .select({ id: t.alerts.id, orgId: t.alerts.orgId, ruleId: t.alerts.ruleId, ingestTs: t.alerts.ingestTs })
    .from(t.alerts)
    .where(
      and(
        eq(t.alerts.status, 'open'),
        isNull(t.alerts.dispatchedAt),
        lte(sql`${t.alerts.firstSeen}`, cutoff),
      ),
    )
    .limit(BATCH);

  if (stale.length === 0) return;

  log.warn({ count: stale.length }, 'sweeper re-enqueuing stale alerts');

  for (const alert of stale) {
    const msg = JSON.stringify({
      alertId: alert.id,
      orgId: alert.orgId,
      ruleId: alert.ruleId,
      ingestTs: alert.ingestTs,
    });
    await redis.xadd(STREAM_ALERTS, '*', 'd', msg);
    sweeperRequeued.inc();
    log.info({ alertId: alert.id }, 'sweeper re-enqueued alert');
  }
}
