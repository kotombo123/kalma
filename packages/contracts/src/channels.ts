import { z } from 'zod';
import { ChannelType, Id } from './common.ts';

export const MessageAction = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['ack', 'approve', 'reject', 'open']),
  /** for approve/reject: the approval id */
  approvalId: Id.optional(),
});
export type MessageAction = z.infer<typeof MessageAction>;

export const RenderedMessage = z.object({
  title: z.string(),
  text: z.string(),
  html: z.string().optional(),
  /** one-liner for SMS / push / Telegram preview */
  short: z.string(),
  /** deep link to the alert in the UI */
  url: z.string(),
  actions: z.array(MessageAction).optional(),
});
export type RenderedMessage = z.infer<typeof RenderedMessage>;

export const ChannelAddress = z.object({
  channel: ChannelType,
  userId: Id.optional(),
  /** email address, telegram chat id, phone number, teams webhook URL… */
  address: z.string(),
});
export type ChannelAddress = z.infer<typeof ChannelAddress>;

export const InboundReply = z.object({
  channel: ChannelType,
  /** provider-side sender (e.g. telegram chat id) */
  from: z.string(),
  kind: z.enum(['ack', 'approve', 'reject', 'link', 'text']),
  alertId: Id.optional(),
  approvalCode: z.string().optional(),
  text: z.string().optional(),
});
export type InboundReply = z.infer<typeof InboundReply>;

export type SendResult = { ok: true; providerId?: string } | { ok: false; retryable: boolean; error: string };

export interface ChannelAdapter {
  type: ChannelType;
  mode: 'real' | 'mock';
  send(msg: RenderedMessage, to: ChannelAddress): Promise<SendResult>;
  /** Telegram */
  startInbound?(handler: (reply: InboundReply) => Promise<void>): Promise<void>;
}
