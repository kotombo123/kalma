import nodemailer from 'nodemailer';
import type { ChannelAdapter, RenderedMessage, ChannelAddress, SendResult, SendError } from '../types.ts';

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser?: string;
  smtpPass?: string;
  from: string;
}

export function createEmailAdapter(config: EmailConfig): ChannelAdapter {
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    auth: config.smtpUser
      ? { user: config.smtpUser, pass: config.smtpPass }
      : undefined,
    secure: false,
  });

  return {
    type: 'email',
    mode: 'real',
    async send(msg: RenderedMessage, to: ChannelAddress): Promise<SendResult | SendError> {
      if (to.channel !== 'email') {
        return { ok: false, retryable: false, error: `Invalid address channel: ${to.channel}` };
      }

      const actionsHtml = msg.actions
        ?.map((a) => `<a href="${msg.url}?action=${a.kind}" style="margin-right:8px">${a.label}</a>`)
        .join('') ?? '';

      try {
        const info = await transporter.sendMail({
          from: config.from,
          to: to.address,
          subject: msg.title,
          text: `${msg.text}\n\n${msg.url}`,
          html: msg.html
            ? `${msg.html}<p>${actionsHtml}</p><p><a href="${msg.url}">View alert</a></p>`
            : `<p>${msg.text}</p>${actionsHtml ? `<p>${actionsHtml}</p>` : ''}<p><a href="${msg.url}">View alert</a></p>`,
        });

        return { ok: true, providerId: info.messageId };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const retryable = !(error.includes('invalid') || error.includes('Invalid'));
        return { ok: false, retryable, error };
      }
    },
  };
}
