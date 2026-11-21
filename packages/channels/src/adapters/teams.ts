import type { ChannelAdapter, RenderedMessage, ChannelAddress, SendResult, SendError } from '../types.ts';

export function createTeamsAdapter(webhookUrl?: string): ChannelAdapter {
  const mode = webhookUrl ? 'real' : 'mock';

  return {
    type: 'teams',
    mode,

    async send(msg: RenderedMessage, to: ChannelAddress): Promise<SendResult | SendError> {
      const url = to.channel === 'teams' ? to.address : webhookUrl;
      if (!url) {
        return { ok: true }; // mock — silently succeed
      }

      const card = {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: msg.title },
                { type: 'TextBlock', text: msg.short, wrap: true },
                { type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'View alert', url: msg.url }] },
              ],
            },
          },
        ],
      };

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(card),
        });
        return res.ok
          ? { ok: true }
          : { ok: false, retryable: res.status >= 500, error: `HTTP ${res.status}` };
      } catch (err) {
        return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
