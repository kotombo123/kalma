/**
 * Mock for F: publishes random UiEvents on `ui:{orgId}` so the UI can be built without B1/B2.
 * Usage: pnpm emit-ui-events [--interval ms=1500] [--once]
 */
import { Alert, SEED, UiEvent, type Severity } from '@alerting/contracts';
import { readJsonFixture } from '@alerting/contracts/fixtures';
import { createRedis, newId, uiChannel } from '@alerting/config';

const args = process.argv.slice(2);
const interval = Number(args[args.indexOf('--interval') + 1]) || 1500;
const once = args.includes('--once');

const redis = createRedis();
const base = Alert.parse(readJsonFixture('alert.sample.json'));
const severities: Severity[] = ['critical', 'error', 'warning', 'info'];
const titles = [
  'order-settlement failed at validate-counterparty',
  'HighErrorRate on payments-api (eu-west)',
  'Rejected EUR 25000000 — LIMIT_BREACH',
  'pricing-engine-3: EURUSD quote latency above threshold',
];
const recent: Alert[] = [];
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

function next(): UiEvent {
  const r = Math.random();
  if (recent.length === 0 || r < 0.4) {
    const now = new Date().toISOString();
    const alert: Alert = {
      ...base,
      id: newId(),
      severity: pick(severities),
      title: pick(titles),
      firstSeen: now,
      lastSeen: now,
      ingestTs: Date.now(),
      count: 1,
    };
    recent.unshift(alert);
    recent.length = Math.min(recent.length, 20);
    return { type: 'alert.created', alert };
  }
  const a = pick(recent);
  if (r < 0.75) {
    a.count += Math.ceil(Math.random() * 20);
    return {
      type: 'alert.updated',
      alertId: a.id,
      patch: { count: a.count, lastSeen: new Date().toISOString() },
    };
  }
  if (r < 0.85) {
    return {
      type: 'delivery.updated',
      delivery: {
        id: newId(),
        alertId: a.id,
        userId: SEED.users.anna,
        channel: pick(['email', 'telegram', 'ui'] as const),
        status: pick(['sent', 'failed', 'sending'] as const),
        attempts: 1,
      },
    };
  }
  if (r < 0.95) {
    return {
      type: 'timeline.appended',
      alertId: a.id,
      entry: {
        id: newId(),
        alertId: a.id,
        ts: new Date().toISOString(),
        actorType: 'system',
        kind: 'action',
        data: { step: 'http_get counterparty-service/health', ok: true },
      },
    };
  }
  return {
    type: 'approval.requested',
    approval: {
      id: newId(),
      alertId: a.id,
      stepId: 's3',
      code: Math.random().toString(36).slice(2, 6),
      status: 'pending',
      requestedAt: new Date().toISOString(),
      text: 'Escalate to counterparty-support',
    },
  };
}

async function tick() {
  const ev = UiEvent.parse(next());
  await redis.publish(uiChannel(SEED.orgId), JSON.stringify(ev));
  console.log(ev.type);
}

if (once) {
  await tick();
  redis.disconnect();
} else {
  console.log(`publishing to ${uiChannel(SEED.orgId)} every ${interval} ms (Ctrl+C to stop)`);
  setInterval(() => void tick(), interval);
}
