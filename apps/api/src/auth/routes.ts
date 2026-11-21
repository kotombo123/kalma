import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import { newId } from '@alerting/config';
import { asc, eq, t } from '@alerting/db';
import type { Deps } from '../deps.ts';
import { conflict, unauthorized } from '../lib/errors.ts';
import { sha256 } from '../lib/crypto.ts';
import { requireAuth } from './guards.ts';
import { refreshStore } from './refresh-store.ts';
import { REFRESH_COOKIE, startSession } from './session.ts';

export const Email = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
/** New passwords: at least 8 characters (login accepts any, e.g. the seed's "demo"). */
export const NewPassword = z.string().min(8).max(200);

/** Same cost for unknown emails so login time does not reveal which accounts exist. */
const DUMMY_HASH = await hash('timing-equalizer');

/** Per-IP limits on endpoints attackers brute-force (OWASP A07). */
export const limits = {
  login: { max: 10, timeWindow: '1 minute' },
  register: { max: 5, timeWindow: '1 minute' },
  refresh: { max: 60, timeWindow: '1 minute' },
};

export async function authRoutes(app: FastifyInstance, deps: Deps) {
  const { db, config } = deps;
  const refresh = refreshStore(deps.redis);
  const session = { db, refresh };
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/auth/register',
    {
      config: { rateLimit: limits.register },
      schema: {
        tags: ['auth'],
        summary: 'Create an organization; the creator becomes its admin',
        body: z.object({
          email: Email,
          password: NewPassword,
          name: z.string().trim().min(1).max(100),
          orgName: z.string().trim().min(1).max(100),
        }),
      },
    },
    async (req, reply) => {
      const { email, password, name, orgName } = req.body;
      const [exists] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.email, email));
      if (exists) throw conflict('email_taken', 'An account with this email already exists');
      const userId = newId();
      const orgId = newId();
      const passwordHash = await hash(password);
      await db.transaction(async (tx) => {
        await tx.insert(t.orgs).values({ id: orgId, name: orgName });
        await tx.insert(t.users).values({ id: userId, email, name, passwordHash });
        await tx.insert(t.memberships).values({ orgId, userId, role: 'admin' });
        await tx
          .insert(t.channelAddresses)
          .values({ userId, channel: 'email', address: email, verified: true });
      });
      req.log.info({ event: 'org_registered', userId, orgId });
      return reply.code(201).send(await startSession(app, reply, session, userId, { orgId }));
    },
  );

  r.post(
    '/auth/login',
    {
      config: { rateLimit: limits.login },
      schema: {
        tags: ['auth'],
        body: z.object({ email: Email, password: z.string().max(200), orgId: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const { email, password, orgId } = req.body;
      const [user] = await db
        .select({ id: t.users.id, passwordHash: t.users.passwordHash })
        .from(t.users)
        .where(eq(t.users.email, email));
      const ok = await verify(user?.passwordHash ?? DUMMY_HASH, password);
      if (!user || !ok) {
        req.log.warn({ event: 'login_failed', emailHash: sha256(email).slice(0, 12), ip: req.ip });
        throw unauthorized('Wrong email or password');
      }
      return startSession(app, reply, session, user.id, { orgId });
    },
  );

  r.post(
    '/auth/refresh',
    {
      config: { rateLimit: limits.refresh },
      schema: { tags: ['auth'], summary: 'Rotate the refresh cookie and get a new access token' },
    },
    async (req, reply) => {
      const token = req.cookies[REFRESH_COOKIE];
      const rotated = token ? await refresh.rotate(token) : null;
      if (!rotated) {
        reply.clearCookie(REFRESH_COOKIE, { path: '/' });
        throw unauthorized('Session expired');
      }
      return startSession(app, reply, session, rotated.session.userId, {
        orgId: rotated.session.orgId,
        refreshToken: rotated.token,
      });
    },
  );

  r.post(
    '/auth/logout',
    { schema: { tags: ['auth'], summary: 'Revoke the refresh token family' } },
    async (req, reply) => {
      const token = req.cookies[REFRESH_COOKIE];
      if (token) await refresh.revoke(token);
      reply.clearCookie(REFRESH_COOKIE, { path: '/' });
      return reply.code(204).send();
    },
  );

  r.get(
    '/me',
    { preHandler: requireAuth, schema: { tags: ['auth'], summary: 'Current user, org, role and teams' } },
    async (req) => {
      const { sub, orgId, role } = req.user;
      const [user] = await db
        .select({
          id: t.users.id,
          email: t.users.email,
          name: t.users.name,
          timezone: t.users.timezone,
          workingHours: t.users.workingHours,
        })
        .from(t.users)
        .where(eq(t.users.id, sub));
      if (!user) throw unauthorized();
      const orgs = await db
        .select({ id: t.orgs.id, name: t.orgs.name, role: t.memberships.role })
        .from(t.memberships)
        .innerJoin(t.orgs, eq(t.orgs.id, t.memberships.orgId))
        .where(eq(t.memberships.userId, sub))
        .orderBy(asc(t.orgs.name));
      const teams = await db
        .select({ id: t.teams.id, name: t.teams.name, role: t.teamMembers.role, orgId: t.teams.orgId })
        .from(t.teamMembers)
        .innerJoin(t.teams, eq(t.teams.id, t.teamMembers.teamId))
        .where(eq(t.teamMembers.userId, sub))
        .orderBy(asc(t.teams.name));
      return {
        user,
        org: orgs.find((o) => o.id === orgId) ?? null,
        role,
        orgs,
        teams: teams.filter((x) => x.orgId === orgId).map(({ orgId: _o, ...x }) => x),
      };
    },
  );

  // "Log in as…" panel. Registered only when NODE_ENV=development — never in production.
  if (config.devRoutes) {
    r.get('/dev/users', { schema: { tags: ['dev'] } }, async () => ({
      data: await db
        .select({ id: t.users.id, email: t.users.email, name: t.users.name })
        .from(t.users)
        .orderBy(asc(t.users.email)),
    }));

    r.post(
      '/dev/login-as',
      { schema: { tags: ['dev'], body: z.object({ email: Email }) } },
      async (req, reply) => {
        const [user] = await db
          .select({ id: t.users.id })
          .from(t.users)
          .where(eq(t.users.email, req.body.email));
        if (!user) throw unauthorized('Unknown user');
        return startSession(app, reply, session, user.id);
      },
    );
  }
}
