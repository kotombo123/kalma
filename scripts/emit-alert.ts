/**
 * Mock of the worker for B2: inserts an alert from a fixture into Postgres and XADDs it to `stream:alerts`.
 * Usage: pnpm emit-alert [fixture=alert.sample.json] [--count N]
 */
import { Alert, AlertStreamMessage } from '@alerting/contracts';
import { readJsonFixture } from '@alerting/contracts/fixtures';
import { createRedis, newId, STREAM_ALERTS } from '@alerting/config';
import { createDb, t } from '@alerting/db';

const args = process.argv.slice(2);
const countIdx = args.indexOf('--count');
const count = countIdx >= 0 ? Number(args[countIdx + 1]) : 1;
const fixture = args.find((a, i) => !a.startsWith('--') && i !== countIdx + 1) ?? 'alert.sample.json';

const { db, sql } = createDb(undefined, 1);
const redis = createRedis();

for (let i = 0; i < count; i++) {
  const now = new Date();
  const alert = Alert.parse({
    ...readJsonFixture<Record<string, unknown>>(fixture),
    id: newId(),
    status: 'open',
    count: 1,
    firstSeen: now.toISOString(),
    lastSeen: now.toISOString(),
    ingestTs: now.getTime(),
  });
  alert.groupKey = `${alert.groupKey}-${alert.id.slice(-6)}`;
  await db.insert(t.alerts).values({ ...alert, escalationLevel: 0 });
  const msg = AlertStreamMessage.parse({
    alertId: alert.id,
    orgId: alert.orgId,
    ruleId: alert.ruleId,
    ingestTs: alert.ingestTs,
  });
  const entry = await redis.xadd(STREAM_ALERTS, '*', 'd', JSON.stringify(msg));
  console.log(`alert ${alert.id} → ${STREAM_ALERTS} ${entry}`);
}

await sql.end();
redis.disconnect();
