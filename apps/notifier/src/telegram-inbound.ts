/**
 * B2-08: Telegram inbound handler.
 * Wires up the telegram adapter's startInbound callback:
 * - /start <CODE> → verify telegram_link_codes, upsert channel_addresses
 * - ACK/Approve/Reject callbacks → call appropriate runbook step actions
 */
import type { Logger } from '@alerting/config';
import { newId, type Redis } from '@alerting/config';
import { type Db, t, eq, and } from '@alerting/db';
import type { InboundReply } from '@alerting/channels';
import { decideApproval } from '@alerting/runbooks';

export function buildInboundHandler(db: Db, redis: Redis, log: Logger) {
  return async (reply: InboundReply): Promise<void> => {
    if (reply.kind === 'link') {
      // /start <CODE> — link Telegram chat to user
      const code = reply.text?.trim() ?? '';
      if (!code) return;

      const linkCode = await db.query.telegramLinkCodes.findFirst({
        where: eq(t.telegramLinkCodes.code, code),
      });

      if (!linkCode) {
        log.warn({ code }, 'telegram link code not found');
        return;
      }

      if (new Date(linkCode.expiresAt) < new Date()) {
        log.warn({ code }, 'telegram link code expired');
        await db.delete(t.telegramLinkCodes).where(eq(t.telegramLinkCodes.code, code));
        return;
      }

      // Upsert channel_addresses row for telegram
      await db
        .insert(t.channelAddresses)
        .values({
          userId: linkCode.userId,
          channel: 'telegram',
          address: reply.from,
          verified: true,
        })
        .onConflictDoUpdate({
          target: [t.channelAddresses.userId, t.channelAddresses.channel],
          set: { address: reply.from, verified: true },
        });

      await db.delete(t.telegramLinkCodes).where(eq(t.telegramLinkCodes.code, code));

      log.info({ userId: linkCode.userId, chatId: reply.from }, 'telegram linked');
      return;
    }

    if (reply.kind === 'ack' && reply.alertId) {
      // Mark alert acknowledged by this Telegram user
      const addrRow = await db.query.channelAddresses.findFirst({
        where: and(
          eq(t.channelAddresses.address, reply.from),
          eq(t.channelAddresses.channel, 'telegram'),
        ),
      });

      if (!addrRow) {
        log.warn({ from: reply.from }, 'telegram ack from unlinked chat');
        return;
      }

      const alertRow = await db.query.alerts.findFirst({
        where: eq(t.alerts.id, reply.alertId),
      });

      if (!alertRow || alertRow.status !== 'open') return;

      await db
        .update(t.alerts)
        .set({ status: 'acknowledged', ackBy: addrRow.userId, ackAt: new Date().toISOString() })
        .where(eq(t.alerts.id, reply.alertId));

      await db.insert(t.alertTimeline).values({
        id: newId(),
        alertId: reply.alertId,
        ts: new Date().toISOString(),
        actorType: 'user',
        actorId: addrRow.userId,
        kind: 'ack',
        data: { via: 'telegram' },
      });

      log.info({ alertId: reply.alertId, userId: addrRow.userId }, 'alert acked via telegram');
      return;
    }

    if ((reply.kind === 'approve' || reply.kind === 'reject') && reply.approvalCode) {
      // Find approval by code
      const approval = await db.query.approvals.findFirst({
        where: and(
          eq(t.approvals.code, reply.approvalCode),
          eq(t.approvals.status, 'pending'),
        ),
      });

      if (!approval) {
        log.warn({ code: reply.approvalCode }, 'approval not found or already decided');
        return;
      }

      // Verify that this Telegram chat belongs to the authorized user
      const addrRow = await db.query.channelAddresses.findFirst({
        where: and(
          eq(t.channelAddresses.address, reply.from),
          eq(t.channelAddresses.channel, 'telegram'),
        ),
      });

      if (!addrRow) {
        log.warn({ from: reply.from }, 'telegram approval from unlinked chat');
        return;
      }

      // Security: verify user belongs to the same org as the alert
      const alertRow = await db.query.alerts.findFirst({
        where: eq(t.alerts.id, approval.alertId),
      });
      if (alertRow) {
        const membership = await db.query.teamMembers.findFirst({
          where: eq(t.teamMembers.userId, addrRow.userId),
        });
        const orgMatch = membership
          ? await db.query.teams.findFirst({
              where: and(eq(t.teams.id, membership.teamId), eq(t.teams.orgId, alertRow.orgId)),
            })
          : null;
        if (!orgMatch) {
          log.warn({ userId: addrRow.userId, alertId: approval.alertId }, 'telegram approval: user not in alert org');
          return;
        }
      }

      const result = await decideApproval(db, redis, {
        approvalId: approval.id,
        decision: reply.kind === 'approve' ? 'approved' : 'rejected',
        actor: { type: 'user', id: addrRow.userId },
        via: 'telegram',
      });

      if (!result.ok) {
        log.warn({ error: result.error }, 'decideApproval failed');
      } else {
        log.info({ approvalId: approval.id, decision: reply.kind }, 'approval decided via telegram');
      }
    }
  };
}
