import Fastify from 'fastify';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { env, createLogger } from '@alerting/config';
import { SEED, SEED_API_KEYS } from '@alerting/contracts';

const e = env();
const log = createLogger('demo-systems');
const app = Fastify({ logger: false });

// --- Simulated services state ---
const serviceHealth: Record<string, { status: number; failCount: number }> = {
  'payments-api': { status: 200, failCount: 0 },
  'counterparty-service': { status: 200, failCount: 0 },
  'workflow-engine': { status: 200, failCount: 0 },
  'pricing-engine': { status: 200, failCount: 0 },
};

const workflows: Record<string, { retries: number; maxFails: number }> = {};
const tickets: { id: string; title: string; severity: string; alertId: string; createdAt: string }[] = [];
const incidents: { id: string; type: string; severity: string; message: string; createdAt: string }[] = [];

// --- Pricing engine log file ---
const LOG_DIR = process.env.LOG_DIR ?? '/tmp/demo-logs';
const pricingLogPath = join(LOG_DIR, 'pricing-engine.log');

/**
 * One pricing-engine log line in the format the seeded file source parses with grok:
 * `<ISO> <LEVEL> [<instance>] <INSTRUMENT> <message>` (rule "Pricing engine warnings" matches
 * service pricing-engine-* and groups by instrument).
 */
function appendPricingLog(instance: string, instrument: string, msg: string, level = 'WARN'): void {
  try {
    const line = `${new Date().toISOString()} ${level} [${instance}] ${instrument} ${msg}\n`;
    const ws = createWriteStream(pricingLogPath, { flags: 'a' });
    ws.write(line);
    ws.end();
  } catch {
    log.warn('could not write pricing log');
  }
}

// --- Ingest webhook event sender ---
async function sendWebhookEvent(payload: unknown): Promise<void> {
  try {
    // the seeded HTTP source ("Alertmanager webhook") and its API key — see SEED in @alerting/contracts
    const res = await fetch(`${e.INGEST_URL}/ingest/${SEED.sources.http}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': SEED_API_KEYS.http },
      body: JSON.stringify(payload),
    });
    if (!res.ok) log.warn({ status: res.status }, 'ingest webhook returned non-2xx');
  } catch (err) {
    log.warn({ err }, 'could not reach ingest, event not sent');
  }
}

// Alertmanager-style firing event
function alertmanagerFiring(alertname: string, labels: Record<string, string>, body: unknown) {
  return {
    version: '4',
    groupLabels: { alertname },
    alerts: [
      {
        status: 'firing',
        labels: { alertname, ...labels },
        annotations: { description: JSON.stringify(body) },
        startsAt: new Date().toISOString(),
      },
    ],
  };
}

function alertmanagerResolved(alertname: string, labels: Record<string, string>) {
  return {
    version: '4',
    groupLabels: { alertname },
    alerts: [
      {
        status: 'resolved',
        labels: { alertname, ...labels },
        endsAt: new Date().toISOString(),
        startsAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ],
  };
}

// --- Health ---
app.get('/health', async (_req, reply) => {
  reply.send({
    status: 'ok',
    services: Object.fromEntries(
      Object.entries(serviceHealth).map(([k, v]) => [k, v.status === 200 ? 'healthy' : 'unhealthy']),
    ),
  });
});

app.get<{ Params: { service: string } }>('/services/:service/health', async (req, reply) => {
  const svc = serviceHealth[req.params.service];
  if (!svc) return reply.status(404).send({ error: 'unknown service' });
  reply.status(svc.status).send({ service: req.params.service, status: svc.status === 200 ? 'ok' : 'down' });
});

app.post<{ Params: { service: string } }>('/services/:service/restart', async (req, reply) => {
  const svc = serviceHealth[req.params.service];
  if (!svc) return reply.status(404).send({ error: 'unknown service' });
  svc.status = 200;
  svc.failCount = 0;
  reply.send({ restarted: true, service: req.params.service });
});

// --- Workflows ---
app.post<{ Params: { id: string }; Body: { reason?: string; alertId?: string } }>(
  '/workflows/:id/retry',
  async (req, reply) => {
    const { id } = req.params;
    if (!workflows[id]) workflows[id] = { retries: 0, maxFails: 2 };
    const wf = workflows[id]!;
    wf.retries += 1;
    if (wf.retries <= wf.maxFails) {
      reply.status(500).send({ ok: false, workflowId: id, retries: wf.retries, error: 'simulated failure' });
    } else {
      reply.send({ ok: true, workflowId: id, retries: wf.retries });
    }
  },
);

// --- Tickets ---
app.post<{ Body: { title: string; severity: string; body?: string; alertId: string } }>(
  '/tickets',
  async (req, reply) => {
    const ticket = {
      id: `TKT-${Date.now()}`,
      title: req.body.title,
      severity: req.body.severity,
      alertId: req.body.alertId,
      createdAt: new Date().toISOString(),
    };
    tickets.push(ticket);
    reply.status(201).send(ticket);
  },
);

app.get('/tickets', async (_req, reply) => {
  reply.send({ tickets });
});

// --- Incidents (poller source) ---
app.get('/incidents', async (_req, reply) => {
  reply.send({ data: { items: incidents } });
});

// --- Scenario controller ---
const SCENARIOS: Record<string, () => Promise<void>> = {
  'settlement-timeout': async () => {
    const id = `WF-${Date.now()}`;
    workflows[id] = { retries: 0, maxFails: 2 };
    serviceHealth['workflow-engine']!.status = 503;
    incidents.push({
      id,
      type: 'workflow.timeout',
      severity: 'critical',
      message: `Workflow ${id} timed out during settlement`,
      createdAt: new Date().toISOString(),
    });
    // Send a workflow-failed event matching the team-settlements rule
    await sendWebhookEvent({
      type: 'WORKFLOW_FAILED',
      workflowId: id,
      workflowName: 'order-settlement',
      step: 'validate-counterparty',
      severity: 'ERROR',
      environment: 'prod',
      timestamp: new Date().toISOString(),
      error: { code: 'TIMEOUT', message: 'Counterparty service did not respond in 5000 ms' },
    });
    log.info({ workflowId: id }, 'scenario: settlement-timeout triggered');
  },

  'payments-error-spike': async () => {
    serviceHealth['payments-api']!.status = 503;
    await sendWebhookEvent(
      alertmanagerFiring(
        'PaymentsHighErrorRate',
        { service: 'payments-api', severity: 'critical' },
        { error_rate: 0.42 },
      ),
    );
    log.info('scenario: payments-error-spike triggered');
  },

  'trade-rejected': async () => {
    const tradeId = `TRD-${Date.now()}`;
    serviceHealth['counterparty-service']!.status = 503;
    incidents.push({
      id: tradeId,
      type: 'trade.rejected',
      severity: 'error',
      message: `Trade ${tradeId} rejected by counterparty`,
      createdAt: new Date().toISOString(),
    });
    await sendWebhookEvent(
      alertmanagerFiring(
        'TradeRejected',
        { trade_id: tradeId, service: 'counterparty-service' },
        { tradeId },
      ),
    );
    log.info({ tradeId }, 'scenario: trade-rejected triggered');
  },

  'pricing-latency': async () => {
    appendPricingLog('pricing-engine-1', 'EURUSD', 'p99 latency 2847ms > threshold 1000ms');
    appendPricingLog('pricing-engine-3', 'GBPUSD', 'p99 latency 3102ms > threshold 1000ms');
    incidents.push({
      id: `PE-${Date.now()}`,
      type: 'pricing.latency',
      severity: 'warning',
      message: 'Pricing engine p99 exceeded threshold',
      createdAt: new Date().toISOString(),
    });
    log.info('scenario: pricing-latency triggered');
  },

  recover: async () => {
    for (const svc of Object.values(serviceHealth)) svc.status = 200;
    incidents.length = 0;
    for (const wf of Object.values(workflows)) {
      wf.retries = wf.maxFails + 1;
    }
    await sendWebhookEvent(alertmanagerResolved('PaymentsHighErrorRate', { service: 'payments-api' }));
    await sendWebhookEvent(alertmanagerResolved('TradeRejected', { service: 'counterparty-service' }));
    log.info('scenario: recover triggered');
  },
};

app.post<{ Params: { name: string } }>('/scenarios/:name', async (req, reply) => {
  const fn = SCENARIOS[req.params.name];
  if (!fn) return reply.status(404).send({ error: `unknown scenario: ${req.params.name}` });
  await fn();
  reply.send({ ok: true, scenario: req.params.name });
});

app.listen({ port: e.DEMO_SYSTEMS_PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    process.exit(1);
  }
  log.info({ port: e.DEMO_SYSTEMS_PORT }, 'ready');
});
