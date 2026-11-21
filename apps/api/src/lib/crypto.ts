import { createHash, randomBytes } from 'node:crypto';

/** sha256 hex — one-time tokens and API keys are stored only as this hash. */
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** URL-safe random token, 256 bits. */
export const randomToken = (): string => randomBytes(32).toString('base64url');

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
/** Escape user-controlled text before putting it into HTML (emails). */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
