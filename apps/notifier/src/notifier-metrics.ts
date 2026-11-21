/**
 * B2-07: Prometheus metrics for the notifier.
 * Registered once; imported by dispatcher, sweeper, escalation.
 */
import { prom, metrics } from '@alerting/config';

export const deliveriesTotal = new prom.Counter({
  name: 'deliveries_total',
  help: 'Total delivery attempts by channel and status',
  labelNames: ['channel', 'status'] as const,
  registers: [metrics()],
});

export const deliveryLatencyMs = new prom.Histogram({
  name: 'delivery_latency_ms',
  help: 'End-to-end delivery latency from alert ingest to sent (ms)',
  labelNames: ['channel'] as const,
  buckets: [100, 500, 1000, 5000, 15000, 60000],
  registers: [metrics()],
});

export const sweeperRequeued = new prom.Counter({
  name: 'sweeper_requeued_total',
  help: 'Alerts re-enqueued by the sweeper',
  registers: [metrics()],
});

export const escalationsTotal = new prom.Counter({
  name: 'escalations_total',
  help: 'Total escalation events',
  labelNames: ['level'] as const,
  registers: [metrics()],
});
