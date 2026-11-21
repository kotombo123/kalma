import { createHash } from 'node:crypto';

/** sha256 hex — how API keys and one-time tokens are stored. */
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Visible prefix of an API key (shown in UI after creation). */
export const keyPrefix = (key: string): string => key.slice(0, 12);
