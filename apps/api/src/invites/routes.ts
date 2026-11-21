import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import { newId } from '@alerting/config';
import { and, desc, eq, isNull, lt, t } from '@alerting/db';
import type { Deps } from '../deps.ts';
import { badRequest, gone, notFound, unauthorized } from '../lib/errors.ts';
import { escapeHtml, randomToken, sha256 } from '../lib/crypto.ts';
import { page, PageQuery } from '../lib/pagination.ts';
import { deny, requireAuth, requireOrgAdmin, teamRoleOf } from '../auth/guards.ts';
import { refreshStore } from '../auth/refresh-store.ts';
import { startSession } from '../auth/session.ts';
import { Email, NewPassword } from '../auth/routes.ts';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

const CreateInvite = z.object({
  email: Email,
  role: z.enum(['admin', 'member']).default('member'),
  teamId: z.string().optional(),
  teamRole: z.enum(['lead', 'member']).optional(),
});
const TokenParams = z.object({ token: z.string().min(20).max(100) });

export async function inviteRoutes(app: FastifyInstance, deps: Deps) {
  const { db, mailer, config } = deps;
  const session = { db, refresh: refreshStore(deps.redis) };
  const r = app.withTypeProvider<ZodTypeProvider>();

  /** Valid, unused, unexpired invite for a token. */
  async function loadInvite(token: string) {
    const [inv] = await db
      .select({
        id: t.invites.id,
        orgId: t.invites.orgId,
        email: t.invites.email,
        role: t.invites.role,
        teamId: t.invites.teamId,
        teamRole: t.invites.teamRole,
        expiresAt: t.invites.expiresAt,
        acceptedAt: t.invites.acceptedAt,
        orgName: t.orgs.name,
      })
      .from(t.invites)
      .innerJoin(t.orgs, eq(t.orgs.id, t.invites.orgId))
      .where(eq(t.invites.tokenHash, sha256(token)));
    if (!inv) throw notFound('Invite not found');
    if (inv.acceptedAt) throw gone('invite_used', 'This invite was already used');
    if (new Date(inv.expiresAt).getTime() < Date.now())
      throw gone('invite_expired', 'This invite has expired');
    return inv;
  }

  /**
   * Org admin: any org role, any team, any team role.
   * Team lead: only org role `member`, only into a team they lead, only as team `member`.
   * The token is returned once and stored hashed; the link is also emailed.
   */
  r.post(
    '/invites',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['invites'], body: CreateInvite },
    },
    async (req, reply) => {
      const { orgId, sub, role: myRole } = req.user;
      const body = req.body;
      let teamName: string | undefined;
      if (body.teamId) {
        const [team] = await db
          .select({ name: t.teams.name })
          .from(t.teams)
          .where(and(eq(t.teams.id, body.teamId), eq(t.teams.orgId, orgId)));
        if (!team) throw notFound('Team not found');
        teamName = team.name;
      }
      if (myRole !== 'admin') {
        const isLead = body.teamId ? (await teamRoleOf(db, orgId, body.teamId, sub)) === 'lead' : false;
        if (!isLead) throw deny(req, 'Only org admins and team leads (for their team) can invite');
        if (body.role !== 'member' || body.teamRole === 'lead')
          throw deny(req, 'Team leads can invite members only');
      }

      const token = randomToken();
      const id = newId();
      await db.insert(t.invites).values({
        id,
        orgId,
        email: body.email,
        role: body.role,
        teamId: body.teamId ?? null,
        teamRole: body.teamId ? (body.teamRole ?? 'member') : null,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      });
      req.log.info({ event: 'invite_created', inviteId: id, by: sub, role: body.role, teamId: body.teamId });

      const link = `${config.publicUrl}/invite/${token}`;
      const [org] = await db.select({ name: t.orgs.name }).from(t.orgs).where(eq(t.orgs.id, orgId));
      const where = teamName ? `${org?.name} (team ${teamName})` : `${org?.name}`;
      let emailed = true;
      try {
        await mailer.send({
          to: body.email,
          subject: `Invitation to ${org?.name ?? 'Kalma'}`,
          text: `You have been invited to ${where}.\nAccept within 7 days: ${link}`,
          html: `<p>You have been invited to <b>${escapeHtml(where)}</b>.</p><p><a href="${escapeHtml(link)}">Accept invitation</a> (valid 7 days)</p>`,
        });
      } catch (err) {
        emailed = false;
        req.log.warn({ err, event: 'invite_email_failed', inviteId: id });
      }
      return reply.code(201).send({ id, link, emailed });
    },
  );

  r.get(
    '/invites',
    {
      preHandler: requireOrgAdmin,
      schema: { tags: ['invites'], summary: 'Pending invites of the org', querystring: PageQuery },
    },
    async (req) => {
      const { limit, cursor } = req.query;
      const rows = await db
        .select({
          id: t.invites.id,
          email: t.invites.email,
          role: t.invites.role,
          teamId: t.invites.teamId,
          teamRole: t.invites.teamRole,
          expiresAt: t.invites.expiresAt,
          createdAt: t.invites.createdAt,
        })
        .from(t.invites)
        .where(
          and(
            eq(t.invites.orgId, req.user.orgId),
            isNull(t.invites.acceptedAt),
            cursor ? lt(t.invites.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(t.invites.id))
        .limit(limit + 1);
      return page(rows, limit);
    },
  );

  r.get(
    '/invites/:token',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['invites'], summary: 'Invite details for the accept page', params: TokenParams },
    },
    async (req) => {
      const inv = await loadInvite(req.params.token);
      const [user] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.email, inv.email));
      const [team] = inv.teamId
        ? await db.select({ name: t.teams.name }).from(t.teams).where(eq(t.teams.id, inv.teamId))
        : [];
      return {
        email: inv.email,
        orgName: inv.orgName,
        role: inv.role,
        teamName: team?.name ?? null,
        teamRole: inv.teamRole,
        expiresAt: inv.expiresAt,
        userExists: Boolean(user),
      };
    },
  );

  /** New user: `name` + `password` create the account. Existing user: confirms with their password. */
  r.post(
    '/invites/:token/accept',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['invites'],
        params: TokenParams,
        body: z.object({ name: z.string().trim().min(1).max(100).optional(), password: z.string().max(200) }),
      },
    },
    async (req, reply) => {
      const inv = await loadInvite(req.params.token);
      const { name, password } = req.body;
      const [existing] = await db
        .select({ id: t.users.id, passwordHash: t.users.passwordHash })
        .from(t.users)
        .where(eq(t.users.email, inv.email));

      let userId: string;
      let passwordHash: string | undefined;
      if (existing) {
        if (!(await verify(existing.passwordHash, password))) {
          req.log.warn({ event: 'invite_accept_failed', inviteId: inv.id, ip: req.ip });
          throw unauthorized('Wrong password');
        }
        userId = existing.id;
      } else {
        if (!name) throw badRequest('name_required', 'Name is required for a new account');
        const pw = NewPassword.safeParse(password);
        if (!pw.success) throw badRequest('weak_password', 'Password must have at least 8 characters');
        userId = newId();
        passwordHash = await hash(password);
      }

      const accepted = await db.transaction(async (tx) => {
        // Single use even under concurrent requests.
        const [claimed] = await tx
          .update(t.invites)
          .set({ acceptedAt: new Date().toISOString() })
          .where(and(eq(t.invites.id, inv.id), isNull(t.invites.acceptedAt)))
          .returning({ id: t.invites.id });
        if (!claimed) return false;
        if (passwordHash && name) {
          await tx.insert(t.users).values({ id: userId, email: inv.email, name, passwordHash });
          await tx
            .insert(t.channelAddresses)
            .values({ userId, channel: 'email', address: inv.email, verified: true });
        }
        await tx
          .insert(t.memberships)
          .values({ orgId: inv.orgId, userId, role: inv.role })
          .onConflictDoNothing();
        if (inv.teamId) {
          await tx
            .insert(t.teamMembers)
            .values({ teamId: inv.teamId, userId, role: inv.teamRole ?? 'member' })
            .onConflictDoNothing();
        }
        return true;
      });
      if (!accepted) throw gone('invite_used', 'This invite was already used');
      req.log.info({ event: 'invite_accepted', inviteId: inv.id, userId });
      return startSession(app, reply, session, userId, { orgId: inv.orgId });
    },
  );
}
