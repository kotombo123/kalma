import nodemailer from 'nodemailer';
import { env } from '@alerting/config';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** SMTP mailer (Mailpit in dev). */
export function smtpMailer(): Mailer {
  const e = env();
  const transport = nodemailer.createTransport({ host: e.SMTP_HOST, port: e.SMTP_PORT, secure: false });
  return {
    async send(mail) {
      await transport.sendMail({ from: e.SMTP_FROM, ...mail });
    },
  };
}

/** In-memory mailer for tests. */
export function memoryMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}
