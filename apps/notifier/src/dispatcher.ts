/**
 * B2-07: Outbox dispatcher.
 * Polls deliveries WHERE status='pending' AND next_attempt_at <= now() (SKIP LOCKED),
 * sends via channel adapter, retries with exponential backoff+jitter,
 * falls back to next channel on MAX_ATTEMPTS, records timeline events, emits metrics.
 */
import type { Logger } from '@alerting/config';
import { newId, createRedis, uiChannel } from '@alerting/config';
import type { Env } from '@alerting/config';
import { UiEvent, type Alert, type RenderedMessage } from '@alerting/contracts';
import { deliveriesTotal, deliveryLatencyMs } from './notifier-metrics.ts';
import { type Db, t, eq, and, lte, alertFromRow } from '@alerting/db';
import {
  uiAdapter,
  createEmailAdapter,
  createTelegramAdapter,
  createTeamsAdapter,
  smsAdapter,
  phoneAdapter,
  type ChannelAdapter,
  type ChannelAddress,
} from '@alerting/channels';
import type { Redis } from '@alerting/config';
import type { ChannelType } from '@alerting/contracts';

const MAX_ATTEMPTS = 6;
const BATCH = 50;
const POLL_INTERVAL_MS = 2000;

// Exponential backoff with jitter: 30s, 60s, 2m, 5m, 15m, 30m
const BACKOFF_DELAYS_MS = [30, 60, 120, 300, 900, 1800].map((s) => s * 1000);

function nextDelay(attempts: number): number {
  const base = BACKOFF_DELAYS_MS[Math.min(attempts, BACKOFF_DELAYS_MS.length - 1)] ?? 1800_000;
  return base + Math.floor(Math.random() * base * 0.1);
}

import { isCircuitOpen, recordFailure, recordSuccess } from './circuit-breaker.ts';

function buildAdapters(e: Env, _redis: Redis): Map<string, ChannelAdapter> {
  const adapters = new Map<string, ChannelAdapter>();
  adapters.set('ui', uiAdapter);
  adapters.set('email', createEmailAdapter({
    smtpHost: e.SMTP_HOST,
    smtpPort: e.SMTP_PORT,
    from: e.SMTP_FROM,
  }));
  if (e.TELEGRAM_BOT_TOKEN) {
    adapters.set('telegram', createTelegramAdapter({ botToken: e.TELEGRAM_BOT_TOKEN }));
  }
  adapters.set('teams', createTeamsAdapter(e.TEAMS_WEBHOOK_URL));
  adapters.set('sms', smsAdapter);
  adapters.set('phone', phoneAdapter);
  return adapters;
}

function buildRenderedMessage(
  alert: Alert,
  e: Env,
  channel: string,
  deliveryPayload?: Record<string, unknown>,
): RenderedMessage {
  const short = `[${alert.severity.toUpperCase()}] ${alert.title}`;
  const text = alert.body ? `${short}\n${alert.body.slice(0, 300)}` : short;
  const url = `${e.PUBLIC_URL}/alerts/${alert.id}`;

  let html: string | undefined;
  if (channel === 'email') {
    const fieldsHtml = alert.fields.length > 0
      ? `<table style="border-collapse:collapse;width:100%;font-size:13px">
          ${alert.fields.map((f) =>
            `<tr><td style="padding:4px 8px;font-weight:bold;color:#555;white-space:nowrap">${esc(f.label)}</td>` +
            `<td style="padding:4px 8px">${esc(String(f.value))}</td></tr>`,
          ).join('')}
        </table>`
      : '';

    const isApprovalRequest = deliveryPayload?.approvalRequest === true;
    const approveUrl = isApprovalRequest
      ? `${e.PUBLIC_URL}/approve/${deliveryPayload!.approvalToken as string}`
      : null;
    const rejectUrl = isApprovalRequest
      ? `${e.PUBLIC_URL}/reject/${deliveryPayload!.approvalToken as string}`
      : null;
    const approvalCode = isApprovalRequest ? (deliveryPayload!.approvalCode as string) : null;

    const approvalHtml = approveUrl
      ? `<div style="margin:16px 0;padding:12px;background:#fffbe6;border:1px solid #ffe58f;border-radius:4px">
          <strong>Approval required</strong><br>
          Telegram: <code>YES ${approvalCode}</code> or <code>NO ${approvalCode}</code><br>
          <a href="${approveUrl}" style="display:inline-block;margin-top:8px;padding:8px 16px;background:#52c41a;color:#fff;border-radius:4px;text-decoration:none">Approve</a>
          &nbsp;
          <a href="${rejectUrl}" style="display:inline-block;margin-top:8px;padding:8px 16px;background:#ff4d4f;color:#fff;border-radius:4px;text-decoration:none">Reject</a>
        </div>`
      : '';

    html = `<div style="font-family:sans-serif;max-width:600px">
      <h2 style="margin:0 0 8px">${esc(alert.title)}</h2>
      <p style="margin:0 0 4px"><strong>Severity:</strong> ${esc(alert.severity)}</p>
      ${alert.body ? `<p style="margin:8px 0;color:#333">${esc(alert.body)}</p>` : ''}
      ${fieldsHtml}
      ${approvalHtml}
      <p style="margin:16px 0"><a href="${url}">View alert →</a></p>
      <p style="margin:0"><a href="${url}/ack" style="padding:8px 16px;background:#1677ff;color:#fff;border-radius:4px;text-decoration:none">Acknowledge</a></p>
    </div>`;
  }

  const actions = [{ id: 'ack', label: 'Acknowledge', kind: 'ack' as const }];
  return { title: alert.title, text, short, url, html, actions };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function runDispatcher(db: Db, e: Env, log: Logger): Promise<void> {
  const redis = createRedis();
  const adapters = buildAdapters(e, redis);

  log.info('dispatcher started');

  while (true) {
    await processBatch(db, redis, adapters, e, log);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function processBatch(
  db: Db,
  redis: Redis,
  adapters: Map<string, ChannelAdapter>,
  e: Env,
  log: Logger,
): Promise<void> {
  // SKIP LOCKED — select pending deliveries
  const rows = await db
    .select()
    .from(t.deliveries)
    .where(
      and(
        eq(t.deliveries.status, 'pending'),
        lte(t.deliveries.nextAttemptAt, new Date().toISOString()),
      ),
    )
    .limit(BATCH)
    .for('update', { skipLocked: true });

  for (const delivery of rows) {
    if (isCircuitOpen(delivery.channel)) {
      log.warn({ channel: delivery.channel }, 'circuit open, skipping delivery');
      continue;
    }

    // Mark as sending
    await db
      .update(t.deliveries)
      .set({ status: 'sending' })
      .where(eq(t.deliveries.id, delivery.id));

    const adapter = adapters.get(delivery.channel);
    if (!adapter) {
      await db
        .update(t.deliveries)
        .set({ status: 'failed', lastError: 'no adapter for channel' })
        .where(eq(t.deliveries.id, delivery.id));
      continue;
    }

    // Fetch alert for rendering
    const alertRow = await db.query.alerts.findFirst({
      where: eq(t.alerts.id, delivery.alertId),
    });
    if (!alertRow) {
      await db
        .update(t.deliveries)
        .set({ status: 'failed', lastError: 'alert not found' })
        .where(eq(t.deliveries.id, delivery.id));
      continue;
    }

    const alert = alertFromRow(alertRow);

    const to: ChannelAddress = { channel: delivery.channel as ChannelType, address: delivery.address };
    const payload = (delivery.payload ?? {}) as Record<string, unknown>;
    const message = buildRenderedMessage(alert, e, delivery.channel, payload);
    const newAttempts = delivery.attempts + 1;

    try {
      const result = await adapter.send(message, to);

      if (result.ok) {
        recordSuccess(delivery.channel);

        await db
          .update(t.deliveries)
          .set({ status: 'sent', attempts: newAttempts, sentAt: new Date().toISOString() })
          .where(eq(t.deliveries.id, delivery.id));

        deliveriesTotal.inc({ channel: delivery.channel, status: 'sent' });
        if (alertRow.ingestTs) {
          deliveryLatencyMs.observe({ channel: delivery.channel }, Date.now() - alertRow.ingestTs);
        }

        // Publish UiEvent on ui:{orgId} for live consumers
        if (delivery.channel === 'ui') {
          try {
            const ev = UiEvent.parse({ type: 'alert.created', alert });
            await redis.publish(uiChannel(alert.orgId), JSON.stringify(ev));
          } catch { /* schema mismatch — skip */ }
        }

        await appendTimeline(db, alert.id, 'delivery', {
          deliveryId: delivery.id,
          channel: delivery.channel,
          userId: delivery.userId,
        });

        log.info({ deliveryId: delivery.id, channel: delivery.channel }, 'sent');
      } else {
        throw new Error((result as { error?: string }).error ?? 'send failed');
      }
    } catch (err: unknown) {
      recordFailure(delivery.channel);
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.warn({ deliveryId: delivery.id, channel: delivery.channel, err: errorMsg }, 'send failed');

      if (newAttempts >= MAX_ATTEMPTS) {
        await db
          .update(t.deliveries)
          .set({ status: 'failed', attempts: newAttempts, lastError: errorMsg })
          .where(eq(t.deliveries.id, delivery.id));
        log.error({ deliveryId: delivery.id, channel: delivery.channel }, 'max attempts reached');
        deliveriesTotal.inc({ channel: delivery.channel, status: 'failed' });

        // Fallback: if email failed, try telegram for the same user
        if (delivery.channel === 'email' && delivery.userId) {
          const tgAddr = await db.query.channelAddresses.findFirst({
            where: and(
              eq(t.channelAddresses.userId, delivery.userId),
              eq(t.channelAddresses.channel, 'telegram'),
            ),
          });
          if (tgAddr) {
            await db.insert(t.deliveries).values({
              id: newId(),
              alertId: delivery.alertId,
              userId: delivery.userId,
              channel: 'telegram',
              address: tgAddr.address,
              status: 'pending',
              attempts: 0,
              nextAttemptAt: new Date().toISOString(),
            }).onConflictDoNothing();
            log.info({ alertId: delivery.alertId, userId: delivery.userId }, 'fallback delivery inserted: telegram');
          }
        }
      } else {
        await db
          .update(t.deliveries)
          .set({
            status: 'pending',
            attempts: newAttempts,
            lastError: errorMsg,
            nextAttemptAt: new Date(Date.now() + nextDelay(newAttempts)).toISOString(),
          })
          .where(eq(t.deliveries.id, delivery.id));
        deliveriesTotal.inc({ channel: delivery.channel, status: 'retry' });
      }
    }
  }
}

async function appendTimeline(
  db: Db,
  alertId: string,
  kind: typeof t.alertTimeline.$inferInsert['kind'],
  data: Record<string, unknown>,
): Promise<void> {
  await db.insert(t.alertTimeline).values({
    id: newId(),
    alertId,
    ts: new Date().toISOString(),
    actorType: 'system',
    kind,
    data,
  });
}
