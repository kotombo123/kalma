/**
 * Rule evaluation throughput (B1-07 target: ≥ 1M evaluations/s for a simple rule).
 * Run: pnpm --filter @alerting/rules bench
 */
import type { Condition } from '@alerting/contracts';
import { compileCondition, type RuleTarget } from '../src/index.ts';

const events: RuleTarget[] = Array.from({ length: 1024 }, (_, i) => ({
  flat: {
    type: i % 3 ? 'WORKFLOW_FAILED' : 'WORKFLOW_OK',
    workflowName: i % 2 ? 'order-settlement' : 'trade-booking',
    environment: i % 5 ? 'prod' : 'uat',
    'payload.notional': i * 25_000,
    service: `pricing-engine-${i % 7}`,
  },
  severity: (['info', 'warning', 'error', 'critical'] as const)[i % 4]!,
  sourceId: 'src',
  schemaId: 'sch',
  status: 'firing',
}));

const cases: [string, Condition][] = [
  ['simple: eq', { field: 'type', op: 'eq', value: 'WORKFLOW_FAILED' }],
  [
    'Team Settlements: all of 3× eq',
    {
      all: [
        { field: 'type', op: 'eq', value: 'WORKFLOW_FAILED' },
        { field: 'workflowName', op: 'eq', value: 'order-settlement' },
        { field: 'environment', op: 'eq', value: 'prod' },
      ],
    },
  ],
  [
    'Team Pricing: glob + $severity in',
    {
      all: [
        { field: 'service', op: 'glob', value: 'pricing-engine-*' },
        { field: '$severity', op: 'in', value: ['warning', 'error', 'critical'] },
      ],
    },
  ],
  ['numeric: gt', { field: 'payload.notional', op: 'gt', value: 10_000_000 }],
];

const N = 5_000_000;
for (const [name, condition] of cases) {
  const test = compileCondition(condition);
  let hits = 0;
  for (let i = 0; i < 200_000; i++) if (test(events[i & 1023]!)) hits++; // warm-up
  hits = 0;
  const start = process.hrtime.bigint();
  for (let i = 0; i < N; i++) if (test(events[i & 1023]!)) hits++;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const perSec = Math.round(N / (ms / 1000));
  console.log(`${name.padEnd(36)} ${(perSec / 1e6).toFixed(1).padStart(6)} M eval/s  (${hits} hits)`);
}
