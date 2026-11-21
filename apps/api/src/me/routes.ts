/**
 * F-07 (part 1) — the signed-in user's notification settings: channel per severity in / outside
 * working hours, working hours + time zone, channel addresses, Telegram linking.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { ChannelType, Severity, WorkingHours } from '@alerting/contracts';
import { and, eq, t } from '@alerting/db';
import { isWorkingHours } from '@alerting/oncall';
import type { Deps } from '../deps.ts';
import { badRequest } from '../lib/errors.ts';
import { publishConfigChanged } from '../lib/config-changed.ts';
import { requireAuth } from '../auth/guards.ts';

const LINK_TTL_MS = 10 * 60 * 1000;
/** Channels a person can type an address for. Telegram is linked through the bot; UI needs none. */
const TypedChannel = z.enum(['email', 'sms', 'phone', 'teams']);
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const TimeZone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone');

/** Unambiguous code for `/start <code>` (no 0/O/1/I). */
function linkCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join('');
}

export async function meRoutes(app: FastifyInstance, { db, redis }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const changed = (orgId: string, userId: string) =>
    publishConfigChanged(redis, { kind: 'prefs', orgId, id: userId });

  async function load(userId: string) {
    const [user] = await db
      .select({ timezone: t.users.timezone, workingHours: t.users.workingHours })
      .from(t.users)
      .where(eq(t.users.id, userId));
    const prefs = await db
      .select({
        severity: t.channelPrefs.severity,
        inHours: t.channelPrefs.inHours,
        offHours: t.channelPrefs.offHours,
      })
      .from(t.channelPrefs)
      .where(eq(t.channelPrefs.userId, userId));
    const addresses = await db
      .select({
        channel: t.channelAddresses.channel,
        address: t.channelAddresses.address,
        verified: t.channelAddresses.verified,
      })
      .from(t.channelAddresses)
      .where(eq(t.channelAddresses.userId, userId));
    const wh = user?.workingHours;
    return {
      timezone: user?.timezone ?? 'Europe/Warsaw',
      workingHours: wh ?? null,
      inWorkingHoursNow: wh ? isWorkingHours({ ...wh, timezone: user!.timezone }, new Date()) : true,
      channelPrefs: Severity.options.map(
        (s) => prefs.find((p) => p.severity === s) ?? { severity: s, inHours: ['ui'], offHours: ['ui'] },
      ),
      addresses,
    };
  }

  r.get('/me/preferences', { preHandler: requireAuth, schema: { tags: ['me'] } }, async (req) =>
    load(req.user.sub),
  );

  r.put(
    '/me/preferences',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['me'],
        body: z.object({
          timezone: TimeZone.optional(),
          workingHours: WorkingHours.extend({ start: HHMM, end: HHMM }).nullable().optional(),
          channelPrefs: z
            .array(
              z.object({
                severity: Severity,
                inHours: z.array(ChannelType).max(7),
                offHours: z.array(ChannelType).max(7),
              }),
            )
            .max(4)
            .optional(),
        }),
      },
    },
    async (req) => {
      const { sub, orgId } = req.user;
      const { timezone, workingHours, channelPrefs } = req.body;
      await db.transaction(async (tx) => {
        if (timezone !== undefined || workingHours !== undefined) {
          await tx
            .update(t.users)
            .set({
              ...(timezone !== undefined && { timezone }),
              ...(workingHours !== undefined && { workingHours }),
            })
            .where(eq(t.users.id, sub));
        }
        for (const p of channelPrefs ?? []) {
          const inHours = [...new Set(p.inHours)];
          const offHours = [...new Set(p.offHours)];
          await tx
            .insert(t.channelPrefs)
            .values({ userId: sub, severity: p.severity, inHours, offHours })
            .onConflictDoUpdate({
              target: [t.channelPrefs.userId, t.channelPrefs.severity],
              set: { inHours, offHours },
            });
        }
      });
      await changed(orgId, sub);
      return load(sub);
    },
  );

  r.put(
    '/me/addresses/:channel',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['me'],
        params: z.object({ channel: TypedChannel }),
        body: z.object({ address: z.string().trim().min(3).max(254) }),
      },
    },
    async (req) => {
      const { channel } = req.params;
      const { address } = req.body;
      if (channel === 'email' && !z.email().safeParse(address).success)
        throw badRequest('invalid_address', 'Invalid email');
      if (channel === 'teams' && !address.startsWith('https://'))
        throw badRequest('invalid_address', 'Teams webhook URL must start with https://');
      if (channel !== 'email' && channel !== 'teams' && !/^\+?[0-9 ()-]{6,20}$/.test(address))
        throw badRequest('invalid_address', 'Invalid phone number');
      const [me] = await db
        .select({ email: t.users.email })
        .from(t.users)
        .where(eq(t.users.id, req.user.sub));
      // only the login email is known to belong to the user; anything else is unverified
      const verified = channel === 'email' && address.toLowerCase() === me?.email;
      await db
        .insert(t.channelAddresses)
        .values({ userId: req.user.sub, channel, address, verified })
        .onConflictDoUpdate({
          target: [t.channelAddresses.userId, t.channelAddresses.channel],
          set: { address, verified },
        });
      await changed(req.user.orgId, req.user.sub);
      return load(req.user.sub);
    },
  );

  r.delete(
    '/me/addresses/:channel',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['me'],
        params: z.object({ channel: z.enum(['email', 'sms', 'phone', 'telegram', 'teams']) }),
      },
    },
    async (req, reply) => {
      await db
        .delete(t.channelAddresses)
        .where(
          and(
            eq(t.channelAddresses.userId, req.user.sub),
            eq(t.channelAddresses.channel, req.params.channel),
          ),
        );
      await changed(req.user.orgId, req.user.sub);
      return reply.code(204).send();
    },
  );

  /** One-time code for the bot: the user sends `/start <code>` and the notifier links the chat. */
  r.post(
    '/me/telegram/link',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['me'] },
    },
    async (req) => {
      const code = linkCode();
      const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
      await db.delete(t.telegramLinkCodes).where(eq(t.telegramLinkCodes.userId, req.user.sub));
      await db.insert(t.telegramLinkCodes).values({ code, userId: req.user.sub, expiresAt });
      return { code, expiresAt, command: `/start ${code}` };
    },
  );
}
