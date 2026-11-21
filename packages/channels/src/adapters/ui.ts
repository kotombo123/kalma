import type { ChannelAdapter, RenderedMessage, ChannelAddress, SendResult } from '../types.ts';

export const uiAdapter: ChannelAdapter = {
  type: 'ui',
  mode: 'real',
  async send(_msg: RenderedMessage, _to: ChannelAddress): Promise<SendResult> {
    // UI channel is delivered via WebSocket in the notifier — no-op here
    return { ok: true };
  },
};
