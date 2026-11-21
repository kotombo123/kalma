/**
 * Server-side access control (OWASP A01). Every protected route uses one of these as `preHandler`.
 * Denials are logged (OWASP A09).
 */
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { and, eq, t, type Db } from '@alerting/db';
import { forbidden, unauthorized } from '../lib/errors.ts';

function deny(req: FastifyRequest, reason: string) {
  req.log.warn({ event: 'access_denied', userId: req.user?.sub, route: req.routeOptions.url, reason });
  return forbidden(reason);
}

/** Valid Bearer access token → `req.user`. */
export const requireAuth: preHandlerAsyncHookHandler = async (req) => {
  try {
    await req.jwtVerify();
  } catch {
    throw unauthorized();
  }
};

/** Org admin only. */
export const requireOrgAdmin: preHandlerAsyncHookHandler = async function (req, reply) {
  await requireAuth.call(this, req, reply);
  if (req.user.role !== 'admin') throw deny(req, 'Organization admin required');
};

export type TeamRole = 'lead' | 'member';

/** Role of a user in a team of the given org (null = not a member, or the team is in another org). */
export async function teamRoleOf(
  db: Db,
  orgId: string,
  teamId: string,
  userId: string,
): Promise<TeamRole | null> {
  const [row] = await db
    .select({ role: t.teamMembers.role })
    .from(t.teamMembers)
    .innerJoin(t.teams, eq(t.teams.id, t.teamMembers.teamId))
    .where(and(eq(t.teamMembers.teamId, teamId), eq(t.teamMembers.userId, userId), eq(t.teams.orgId, orgId)));
  return row?.role ?? null;
}

/**
 * Team lead / member of the team `teamIdOf(req)` returns. Org admins always pass.
 * Example: `preHandler: requireTeamRole(db, (req) => (req.params as { teamId: string }).teamId, 'lead')`.
 */
export function requireTeamRole(
  db: Db,
  teamIdOf: (req: FastifyRequest) => string | undefined,
  min: TeamRole,
): preHandlerAsyncHookHandler {
  return async function (req, reply) {
    await requireAuth.call(this, req, reply);
    if (req.user.role === 'admin') return;
    const teamId = teamIdOf(req);
    const role = teamId ? await teamRoleOf(db, req.user.orgId, teamId, req.user.sub) : null;
    if (!role || (min === 'lead' && role !== 'lead')) throw deny(req, `Team ${min} required`);
  };
}

export { deny };
