import { Bot } from 'grammy';
import type { ChannelAdapter, RenderedMessage, ChannelAddress, SendResult, SendError, InboundReply } from '../types.ts';

export interface TelegramConfig {
  botToken: string;
}

export function createTelegramAdapter(config: TelegramConfig): ChannelAdapter {
  const bot = new Bot(config.botToken);
  let started = false;

  return {
    type: 'telegram',
    mode: 'real',

    async send(msg: RenderedMessage, to: ChannelAddress): Promise<SendResult | SendError> {
      if (to.channel !== 'telegram') {
        return { ok: false, retryable: false, error: `Invalid address channel: ${to.channel}` };
      }

      const chatId = Number(to.address);
      if (!Number.isFinite(chatId)) {
        return { ok: false, retryable: false, error: `Invalid Telegram chat id: ${to.address}` };
      }

      const keyboard = msg.actions?.map((a) => ({
        text: a.label,
        callback_data: `${a.kind}:${a.id}`,
      }));

      const text = `*${escapeMarkdown(msg.title)}*\n${escapeMarkdown(msg.short)}\n\n[View alert](${msg.url})`;

      try {
        const sent = await bot.api.sendMessage(chatId, text, {
          parse_mode: 'MarkdownV2',
          reply_markup: keyboard?.length
            ? { inline_keyboard: [keyboard] }
            : undefined,
        });
        return { ok: true, providerId: String(sent.message_id) };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const retryable = !error.includes('chat not found') && !error.includes('blocked');
        return { ok: false, retryable, error };
      }
    },

    async startInbound(handler: (reply: InboundReply) => Promise<void>): Promise<void> {
      if (started) return;
      started = true;

      bot.on('callback_query:data', async (ctx) => {
        const [kind, actionId] = ctx.callbackQuery.data.split(':');
        if (!kind || !actionId) return;
        if (!['ack', 'approve', 'reject'].includes(kind)) return;

        await handler({
          channel: 'telegram',
          from: String(ctx.from.id),
          kind: kind as 'ack' | 'approve' | 'reject',
          alertId: actionId,
        });

        await ctx.answerCallbackQuery({ text: 'Done' }).catch(() => null);
      });

      bot.on('message:text', async (ctx) => {
        const raw = ctx.message.text.trim();

        // /start <CODE> — link Telegram chat to a user account
        if (raw.startsWith('/start')) {
          const code = raw.slice(6).trim();
          await handler({
            channel: 'telegram',
            from: String(ctx.from.id),
            kind: 'link',
            text: code,
          });
          return;
        }

        // YES <CODE> / NO <CODE> — approve or reject a step
        const upper = raw.toUpperCase();
        const parts = upper.split(/\s+/);
        if (parts.length === 2 && ['YES', 'NO'].includes(parts[0] ?? '')) {
          const kind = parts[0] === 'YES' ? 'approve' : 'reject';
          await handler({
            channel: 'telegram',
            from: String(ctx.from.id),
            kind,
            approvalCode: parts[1],
          });
        }
      });

      bot.start({ onStart: () => {} });
    },
  };
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, (c) => `\\${c}`);
}
