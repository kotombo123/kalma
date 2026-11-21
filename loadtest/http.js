// B1-17: k6 load test for POST /ingest/:sourceId (NDJSON batches).
//   SCENARIO=constant  RATE req/s for DURATION
//   SCENARIO=ramp      0 → RATE req/s over DURATION, then hold for a third of it
// Each request carries BATCH events: 70% duplicates (a small pool of trade ids), 25% unique
// events matching the Rates rule, 5% unknown shapes. Messages per second = RATE × BATCH.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const URL = __ENV.INGEST_URL || 'http://localhost:3001';
const SOURCE = __ENV.SOURCE_ID || '01HZZACME00000000000000401';
const KEY = __ENV.API_KEY || 'ak_demo_http_0123456789abcdef';
const RATE = Number(__ENV.RATE || 1000);
const BATCH = Number(__ENV.BATCH || 10);
const DURATION = __ENV.DURATION || '60s';
const RUN = __ENV.RUN_ID || `${Date.now()}`;
const DUP_PCT = Number(__ENV.DUP_PCT || 70);
const UNKNOWN_PCT = Number(__ENV.UNKNOWN_PCT || 5);

const messages = new Counter('messages');
const rejected = new Counter('rejected_503');

const seconds = (d) => Number(d.replace(/s$/, ''));
export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    load:
      (__ENV.SCENARIO || 'constant') === 'ramp'
        ? {
            executor: 'ramping-arrival-rate',
            startRate: 0,
            timeUnit: '1s',
            preAllocatedVUs: 200,
            maxVUs: 2000,
            stages: [
              { target: RATE, duration: DURATION },
              { target: RATE, duration: `${Math.ceil(seconds(DURATION) / 3)}s` },
            ],
          }
        : {
            executor: 'constant-arrival-rate',
            rate: RATE,
            timeUnit: '1s',
            duration: DURATION,
            preAllocatedVUs: 200,
            maxVUs: 2000,
          },
  },
  thresholds: { http_req_failed: ['rate<0.01'] },
};

const DESKS = ['rates', 'rates', 'rates', 'fx'];
const REASONS = ['LIMIT_BREACH', 'PRICE_TOLERANCE', 'CREDIT_CHECK'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function trade(tradeId) {
  return {
    meta: { schema: 'trade.rejected.v2', producer: 'trade-gateway', ts: Date.now() },
    payload: {
      tradeId,
      desk: pick(DESKS),
      notional: 10_000_001 + Math.floor(Math.random() * 90_000_000),
      currency: pick(['EUR', 'USD', 'GBP']),
      reason: pick(REASONS),
    },
  };
}

// A handful of shapes no schema knows yet (each becomes one schema, not one per event).
function unknown() {
  const n = Math.floor(Math.random() * 10);
  return { [`evt_${n}`]: 'load.unknown', host: { name: `node-${n}` }, value: Math.random(), [`k${n}`]: n };
}

let seq = 0;
function event() {
  const r = Math.random() * 100;
  if (r < UNKNOWN_PCT) return unknown();
  if (r < UNKNOWN_PCT + DUP_PCT) return trade(`LT-${RUN}-HOT-${Math.floor(Math.random() * 50)}`);
  return trade(`LT-${RUN}-${__VU}-${seq++}`);
}

export default function () {
  const lines = [];
  for (let i = 0; i < BATCH; i++) lines.push(JSON.stringify(event()));
  const res = http.post(`${URL}/ingest/${SOURCE}`, lines.join('\n'), {
    headers: { 'content-type': 'application/x-ndjson', 'x-api-key': KEY },
  });
  if (res.status === 202) messages.add(BATCH);
  if (res.status === 503) rejected.add(1);
  check(res, { 'accepted (202)': (r) => r.status === 202 });
}

export function handleSummary(data) {
  const out = __ENV.SUMMARY || 'loadtest/out/k6-summary.json';
  return { [out]: JSON.stringify(data, null, 2), stdout: textLine(data) };
}

function textLine(d) {
  const m = d.metrics;
  const v = (k, f) => (m[k] && m[k].values[f] !== undefined ? m[k].values[f] : 0);
  return (
    `\nrequests ${v('http_reqs', 'count')} (${v('http_reqs', 'rate').toFixed(0)}/s), ` +
    `messages ${v('messages', 'count')} (${v('messages', 'rate').toFixed(0)}/s), ` +
    `http p50 ${v('http_req_duration', 'p(50)').toFixed(1)} ms, p99 ${v('http_req_duration', 'p(99)').toFixed(1)} ms, ` +
    `failed ${(v('http_req_failed', 'rate') * 100).toFixed(2)}%, 503 ${v('rejected_503', 'count')}\n`
  );
}
