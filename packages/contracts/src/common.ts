import { z } from 'zod';

/** ULID string. */
export const Id = z.string().min(1);
/** ISO-8601 timestamp in UTC. */
export const IsoDate = z.string();

export const Severity = z.enum(['critical', 'error', 'warning', 'info']);
export type Severity = z.infer<typeof Severity>;
export const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warning: 1, error: 2, critical: 3 };

export const ChannelType = z.enum(['ui', 'email', 'telegram', 'teams', 'sms', 'phone']);
export type ChannelType = z.infer<typeof ChannelType>;

/** Error-as-value convention for domain functions. */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
