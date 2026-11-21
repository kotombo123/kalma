export type { ChannelAdapter, RenderedMessage, ChannelAddress, InboundReply, SendResult, SendError, ChannelType } from './types.ts';
export { uiAdapter } from './adapters/ui.ts';
export { createEmailAdapter } from './adapters/email.ts';
export type { EmailConfig } from './adapters/email.ts';
export { createTelegramAdapter } from './adapters/telegram.ts';
export type { TelegramConfig } from './adapters/telegram.ts';
export { createTeamsAdapter } from './adapters/teams.ts';
export { smsAdapter, phoneAdapter } from './adapters/sms-phone.ts';
