/**
 * Who sees which alert (OWASP A01): org admins see every alert of the org; everyone else sees
 * alerts of their teams and alerts they were notified about. Hidden alerts are 404, not 403.
 */
import { and, eq, inArray, or, t, type Db, type SQL } from '@alerting/db';
import { notFound } from '../lib/errors.ts';

export interface Viewer {
  sub: string;
  orgId: string;
  role: 'admin' | 'member';
}

/** WHERE clause limiting `alerts` to what the viewer may see. */
export function visibleAlerts(db: Db, v: Viewer): SQL {
  const inOrg = eq(t.alerts.orgId, v.orgId);
  if (v.role === 'admin') return inOrg;
  const myTeams = db
    .select({ id: t.teamMembers.teamId })
    .from(t.teamMembers)
    .where(eq(t.teamMembers.userId, v.sub));
  const notifiedMe = db
    .select({ id: t.deliveries.alertId })
    .from(t.deliveries)
    .where(eq(t.deliveries.userId, v.sub));
  return and(inOrg, or(inArray(t.alerts.teamId, myTeams), inArray(t.alerts.id, notifiedMe)))!;
}

export async function loadVisibleAlert(db: Db, v: Viewer, alertId: string) {
  const [row] = await db
    .select()
    .from(t.alerts)
    .where(and(eq(t.alerts.id, alertId), visibleAlerts(db, v)));
  if (!row) throw notFound('Alert not found');
  return row;
}
