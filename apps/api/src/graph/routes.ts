/**
 * F-09 — dependency graph and stats. Both are limited to the alerts the viewer can see
 * (visibleAlerts) whose first event falls in [from, to).
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GraphResponse, StatsResponse, type ChannelType, type DeliveryState } from '@alerting/contracts';
import type { Deps } from '../deps.ts';
import { badRequest } from '../lib/errors.ts';
import { requireAuth } from '../auth/guards.ts';
import { buildGraph } from './build.ts';
import {
  alertFlows,
  alertScope,
  escalations,
  notifications,
  orgDirectory,
  personTimes,
  ruleNames,
  statsQueries,
} from './queries.ts';

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_MS = 7 * DAY_MS;
const MAX_RANGE_MS = 90 * DAY_MS;

export const RangeQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  teamId: z.string().min(1).max(64).optional(),
});

/** Defaults to the last 7 days; at most 90 days. */
export function resolveRange(q: z.infer<typeof RangeQuery>, now = Date.now()) {
  const to = q.to ? Date.parse(q.to) : now;
  const from = q.from ? Date.parse(q.from) : to - DEFAULT_RANGE_MS;
  if (from >= to) throw badRequest('invalid_range', '`from` must be before `to`');
  if (to - from > MAX_RANGE_MS) throw badRequest('invalid_range', 'The range can be at most 90 days');
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

const mean = (sum: number, n: number) => (n > 0 ? Math.round(sum / n) : null);

export async function graphRoutes(app: FastifyInstance, { db }: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/graph',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['graph'],
        summary: 'Sources → rules → teams → people with alert volumes and per-person load',
        querystring: RangeQuery,
        response: { 200: GraphResponse },
      },
    },
    async (req) => {
      const { from, to } = resolveRange(req.query);
      const scope = alertScope(db, { viewer: req.user, from, to, teamId: req.query.teamId });
      const [flows, notified, times, escalated, directory] = await Promise.all([
        alertFlows(db, scope),
        notifications(db, scope),
        personTimes(db, scope),
        escalations(db, scope),
        orgDirectory(db, req.user.orgId),
      ]);
      return buildGraph({
        from,
        to,
        flows,
        notifications: notified,
        times,
        escalations: escalated,
        directory,
      });
    },
  );

  r.get(
    '/stats',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['graph'],
        summary: 'Totals, alerts per hour, top rules and delivery status per channel',
        querystring: RangeQuery,
        response: { 200: StatsResponse },
      },
    },
    async (req) => {
      const { from, to } = resolveRange(req.query);
      const scope = alertScope(db, { viewer: req.user, from, to, teamId: req.query.teamId });
      const s = await statsQueries(db, scope);
      const names = await ruleNames(
        db,
        req.user.orgId,
        s.topRules.map((x) => x.ruleId),
      );

      const channels = new Map<ChannelType, Partial<Record<DeliveryState, number>>>();
      for (const c of s.channels) {
        const counts = channels.get(c.channel) ?? {};
        counts[c.status] = c.n;
        channels.set(c.channel, counts);
      }

      return {
        from,
        to,
        totals: {
          alerts: s.totals.alerts,
          open: s.totals.open,
          acknowledged: s.totals.acknowledged,
          resolved: s.totals.resolved,
          mttaSec: mean(s.totals.ackSec, s.totals.acked),
          mttrSec: mean(s.totals.resolveSec, s.totals.resolvedWithTime),
        },
        alertsPerHour: s.perHour.map((h) => ({ hour: new Date(h.hour).toISOString(), alerts: h.alerts })),
        topRules: s.topRules.map((x) => ({ ...x, name: names.get(x.ruleId) ?? x.ruleId })),
        channels: [...channels].map(([channel, counts]) => ({ channel, counts })),
      };
    },
  );
}
