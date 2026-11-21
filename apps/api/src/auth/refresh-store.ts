/**
 * Opaque refresh tokens in Redis (OWASP A07): stored hashed, rotated on every use, revocable.
 * Reusing an already rotated token revokes the whole token family (stolen-token detection).
 */
import type { Redis } from '@alerting/config';
import { newId } from '@alerting/config';
import { randomToken, sha256 } from '../lib/crypto.ts';

export const REFRESH_TTL_SEC = 7 * 24 * 3600;

const tokenKey = (hash: string) => `auth:rt:${hash}`;
const usedKey = (hash: string) => `auth:rt-used:${hash}`;
const familyKey = (family: string) => `auth:rt-family:${family}`;

export interface RefreshSession {
  userId: string;
  orgId: string;
  family: string;
}

export function refreshStore(redis: Redis) {
  async function issue(s: Omit<RefreshSession, 'family'> & { family?: string }): Promise<string> {
    const token = randomToken();
    const hash = sha256(token);
    const session: RefreshSession = { ...s, family: s.family ?? newId() };
    await redis
      .multi()
      .set(tokenKey(hash), JSON.stringify(session), 'EX', REFRESH_TTL_SEC)
      .sadd(familyKey(session.family), hash)
      .expire(familyKey(session.family), REFRESH_TTL_SEC)
      .exec();
    return token;
  }

  async function revokeFamily(family: string) {
    const hashes = await redis.smembers(familyKey(family));
    const m = redis.multi().del(familyKey(family));
    for (const h of hashes) m.del(tokenKey(h));
    await m.exec();
  }

  /** Returns the session and a new token, or null (unknown, expired, reused). */
  async function rotate(token: string): Promise<{ session: RefreshSession; token: string } | null> {
    const hash = sha256(token);
    const raw = await redis.getdel(tokenKey(hash));
    if (!raw) {
      const family = await redis.get(usedKey(hash));
      if (family) await revokeFamily(family);
      return null;
    }
    const session = JSON.parse(raw) as RefreshSession;
    await redis.set(usedKey(hash), session.family, 'EX', REFRESH_TTL_SEC);
    return { session, token: await issue(session) };
  }

  async function revoke(token: string) {
    const raw = await redis.get(tokenKey(sha256(token)));
    if (raw) await revokeFamily((JSON.parse(raw) as RefreshSession).family);
  }

  return { issue, rotate, revoke };
}
export type RefreshStore = ReturnType<typeof refreshStore>;
