import type { ChannelAdapter, RenderedMessage, ChannelAddress, SendError } from '../types.ts';

function notConfigured(type: 'sms' | 'phone'): ChannelAdapter {
  return {
    type,
    mode: 'mock',
    async send(_msg: RenderedMessage, _to: ChannelAddress): Promise<SendError> {
      return { ok: false, retryable: false, error: `${type} channel not configured — add a provider (e.g. Twilio)` };
    },
  };
}

export const smsAdapter: ChannelAdapter = notConfigured('sms');
export const phoneAdapter: ChannelAdapter = notConfigured('phone');
