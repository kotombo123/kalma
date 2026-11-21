import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, asc, eq, t, type Db } from '@alerting/db';
import { unauthorized } from '../lib/errors.ts';
import { REFRESH_TTL_SEC, type RefreshStore } from './refresh-store.ts';

export type OrgRole = 'admin' | 'member';

/** Access-token claims. Short-lived (15 min); the refresh token is opaque and lives in Redis. */
export interface AccessClaims {
  sub: string;
  orgId: string;
  role: OrgRole;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessClaims;
    user: AccessClaims;
  }
}

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_COOKIE = 'rt';

/** Membership in `orgId`, or the user's first org when not given. */
export async function membershipFor(db: Db, userId: string, orgId?: string) {
  const [m] = await db
    .select({ orgId: t.memberships.orgId, role: t.memberships.role, orgName: t.orgs.name })
    .from(t.memberships)
    .innerJoin(t.orgs, eq(t.orgs.id, t.memberships.orgId))
    .where(
      orgId
        ? and(eq(t.memberships.userId, userId), eq(t.memberships.orgId, orgId))
        : eq(t.memberships.userId, userId),
    )
    .orderBy(asc(t.memberships.orgId))
    .limit(1);
  return m;
}

export function setRefreshCookie(app: FastifyInstance, reply: FastifyReply, token: string) {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: app.appConfig.secureCookies,
    maxAge: REFRESH_TTL_SEC,
  });
}

/**
 * Issues an access token (response body) and a refresh token (httpOnly cookie).
 * Pass `refreshToken` when it was already rotated by the refresh store.
 */
export async function startSession(
  app: FastifyInstance,
  reply: FastifyReply,
  deps: { db: Db; refresh: RefreshStore },
  userId: string,
  opts: { orgId?: string; refreshToken?: string } = {},
) {
  const m = await membershipFor(deps.db, userId, opts.orgId);
  if (!m) throw unauthorized('User is not a member of this organization');
  const [user] = await deps.db
    .select({ id: t.users.id, email: t.users.email, name: t.users.name })
    .from(t.users)
    .where(eq(t.users.id, userId));
  if (!user) throw unauthorized();

  const accessToken = app.jwt.sign({ sub: userId, orgId: m.orgId, role: m.role });
  const refreshToken = opts.refreshToken ?? (await deps.refresh.issue({ userId, orgId: m.orgId }));
  setRefreshCookie(app, reply, refreshToken);
  return {
    accessToken,
    expiresIn: ACCESS_TTL_SEC,
    user,
    org: { id: m.orgId, name: m.orgName },
    role: m.role,
  };
}
