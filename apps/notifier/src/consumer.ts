/**
 * Reads stream:alerts via Redis consumer group 'notifiers'.
 * On each message: dispatch alert, then XACK.
 */
import type { Redis } from '@alerting/config';
import { STREAM_ALERTS, GROUP_NOTIFIERS } from '@alerting/config';
import { AlertStreamMessage } from '@alerting/contracts';
import type { Logger } from '@alerting/config';
import type { Db } from '@alerting/db';
import { dispatchAlert } from './dispatch.ts';

const CONSUMER_NAME = `notifier-${process.pid}`;
const BLOCK_MS = 2000;
const BATCH = 50;

export async function ensureGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup('CREATE', STREAM_ALERTS, GROUP_NOTIFIERS, '0', 'MKSTREAM');
  } catch (err: unknown) {
    if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) throw err;
  }
}

export async function runConsumer(redis: Redis, db: Db, log: Logger): Promise<void> {
  await ensureGroup(redis);
  log.info('consumer started');

  while (true) {
    const reply = await redis.xreadgroup(
      'GROUP',
      GROUP_NOTIFIERS,
      CONSUMER_NAME,
      'COUNT',
      BATCH,
      'BLOCK',
      BLOCK_MS,
      'STREAMS',
      STREAM_ALERTS,
      '>',
    ) as [string, [string, string[]][]][] | null;

    if (!reply) continue;

    for (const [, entries] of reply) {
      for (const [msgId, fields] of entries) {
        const raw = Object.fromEntries(
          fields.reduce<[string, string][]>((acc, v, i) => {
            if (i % 2 === 0) acc.push([v, fields[i + 1] ?? '']);
            return acc;
          }, []),
        );

        let parsed: ReturnType<typeof AlertStreamMessage.safeParse>;
        try {
          parsed = AlertStreamMessage.safeParse(JSON.parse(raw.d ?? '{}'));
        } catch {
          log.warn({ msgId }, 'malformed message, skipping');
          await redis.xack(STREAM_ALERTS, GROUP_NOTIFIERS, msgId);
          continue;
        }

        if (!parsed.success) {
          log.warn({ msgId, error: parsed.error.message }, 'invalid AlertStreamMessage');
          await redis.xack(STREAM_ALERTS, GROUP_NOTIFIERS, msgId);
          continue;
        }

        try {
          await dispatchAlert(db, redis, log, parsed.data);
          await redis.xack(STREAM_ALERTS, GROUP_NOTIFIERS, msgId);
        } catch (err) {
          log.error({ err, msgId, alertId: parsed.data.alertId }, 'dispatch failed, will retry');
        }
      }
    }
  }
}
