/**
 * Stable ids of seed entities (scripts/seed.ts). Fixtures and mocks reference these, so every
 * teammate can test against the same data. Valid ULID-shaped strings.
 */
const id = (n: number) => `01HZZACME${String(n).padStart(17, '0')}`;

export const SEED = {
  orgId: id(1),
  users: {
    admin: id(101),
    anna: id(102),
    settlementsLead: id(103),
    settlementsMember: id(104),
    pricingLead: id(105),
    pricingMember: id(106),
    ratesLead: id(107),
    ratesMember: id(108),
    paymentsLead: id(109),
  },
  teams: {
    settlements: id(201),
    pricing: id(202),
    rates: id(203),
    payments: id(204),
    counterpartySupport: id(205),
  },
  systems: {
    workflowEngine: id(301),
    payments: id(302),
    pricing: id(303),
    trading: id(304),
  },
  sources: {
    /** HTTP webhook (Alertmanager) — api key `ak_demo_http` */
    http: id(401),
    /** Kafka topic `workflow-events` — workflow failures + trade rejections */
    kafka: id(402),
    /** File tail of pricing-engine log */
    file: id(403),
    /** Poller of demo-systems /incidents */
    poll: id(404),
  },
  rules: {
    settlements: id(501),
    pricing: id(502),
    rates: id(503),
    anna: id(504),
  },
  runbooks: {
    settlementTimeout: id(601),
    paymentsHighErrorRate: id(602),
    pricingLatency: id(603),
  },
  schedules: {
    settlements: id(701),
    pricing: id(702),
  },
  /** Seeded schema + alert used by alert.sample.json */
  schemas: { workflowFailed: id(801) },
  mappings: { workflowFailed: id(802) },
  alerts: { sample: id(901) },
} as const;

/** Plain-text API keys of seed sources (dev only). */
export const SEED_API_KEYS = {
  http: 'ak_demo_http_0123456789abcdef',
  kafka: 'ak_demo_kafka_0123456789abcdef',
  file: 'ak_demo_file_0123456789abcdef',
  poll: 'ak_demo_poll_0123456789abcdef',
} as const;

export const SEED_PASSWORD = 'demo';
