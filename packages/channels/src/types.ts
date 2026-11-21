import type { SendResult } from '@alerting/contracts';

export type {
  ChannelType,
  RenderedMessage,
  ChannelAddress,
  InboundReply,
  SendResult,
  ChannelAdapter,
  MessageAction,
} from '@alerting/contracts';

/** Convenience type for the error branch of SendResult. */
export type SendError = Extract<SendResult, { ok: false }>;
