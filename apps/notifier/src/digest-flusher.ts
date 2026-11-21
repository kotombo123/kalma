/**
 * B2-05: Digest flusher.
 * Every DIGEST_INTERVAL_MS, drains all digest queues and inserts a single
 * bundled delivery row per (userId, channel) so the dispatcher sends one
 * aggregated notification instead of many individual ones.
 */
import type { Logger } from '@alerting/config';
import { newId, type Redis } from '@alerting/config';
import { type Db, t, eq, and } from '@alerting/db';
import { drainDigests, DIGEST_INTERVAL_MS } from './throttle.ts';

export async function runDigestFlusher(db: Db, redis: Redis, log: Logger): Promise<void> {
  log.info('digest flusher started');
  while (true) {
    await new Promise((r) => setTimeout(r, DIGEST_INTERVAL_MS));
    await flushDigests(db, redis, log);
  }
}

async function flushDigests(db: Db, redis: Redis, log: Logger): Promise<void> {
  const digests = await drainDigests(redis);
  if (digests.length === 0) return;

  for (const { userId, channel, alertIds } of digests) {
    // Pick the most recent alert as the "primary" for the delivery row
    const primaryAlertId = alertIds[alertIds.length - 1]!;

    const alertRow = await db.query.alerts.findFirst({ where: eq(t.alerts.id, primaryAlertId) });
    if (!alertRow) continue;

    const addrRow = await db.query.channelAddresses.findFirst({
      where: and(
        eq(t.channelAddresses.userId, userId),
        eq(t.channelAddresses.channel, channel as typeof t.channelAddresses.$inferSelect['channel']),
      ),
    });

    const address =
      channel === 'ui'
        ? `ui:${alertRow.orgId}`
        : addrRow?.address;

    if (!address) continue;

    await db
      .insert(t.deliveries)
      .values({
        id: newId(),
        alertId: primaryAlertId,
        userId,
        channel: channel as typeof t.deliveries.$inferInsert['channel'],
        address,
        payload: { digest: true, alertIds, count: alertIds.length },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
      })
      .onConflictDoNothing();

    log.info({ userId, channel, count: alertIds.length }, 'digest delivery inserted');
  }
}
