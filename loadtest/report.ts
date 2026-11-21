/**
 * B1-17 report: reads one load-test window from Prometheus, adds it to loadtest/results/runs.json,
 * and rewrites loadtest/RESULTS.md (table of all runs) plus a PNG chart for this run.
 *
 *   tsx loadtest/report.ts --from <epoch s> --to <epoch s> --label "http 1000 req/s × 10" \
 *     [--workers 1] [--k6 loadtest/out/k6-summary.json] [--prometheus http://localhost:9090]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';

const { values: a } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    label: { type: 'string', default: 'run' },
    workers: { type: 'string', default: '1' },
    k6: { type: 'string' },
    /** Seconds of load from --from; throughput averages use this, latency the whole window. */
    'load-seconds': { type: 'string' },
    prometheus: { type: 'string', default: process.env.PROMETHEUS_URL ?? 'http://localhost:9090' },
    dir: { type: 'string', default: 'loadtest' },
  },
});
if (!a.from || !a.to) throw new Error('--from and --to (epoch seconds) are required');
const from = Number(a.from);
const to = Number(a.to);
const window = Math.max(10, Math.round(to - from));
const PROM = a.prometheus!;

async function query(expr: string, time = to): Promise<{ metric: Record<string, string>; value: number }[]> {
  const url = `${PROM}/api/v1/query?${new URLSearchParams({ query: expr, time: String(time) })}`;
  const body = (await (await fetch(url)).json()) as {
    data: { result: { metric: Record<string, string>; value: [number, string] }[] };
  };
  return body.data.result.map((r) => ({ metric: r.metric, value: Number(r.value[1]) }));
}
const scalar = async (expr: string) => {
  const v = (await query(expr))[0]?.value;
  return v === undefined || Number.isNaN(v) ? null : v;
};
async function range(expr: string, step = 2): Promise<[number, number][]> {
  const url = `${PROM}/api/v1/query_range?${new URLSearchParams({ query: expr, start: String(from), end: String(to), step: String(step) })}`;
  const body = (await (await fetch(url)).json()) as { data: { result: { values: [number, string][] }[] } };
  return (body.data.result[0]?.values ?? []).map(([t, v]) => [t, Number(v)] as [number, number]);
}

const W = `${window}s`;
const loadSec = Math.min(window, Number(a['load-seconds'] ?? window));
const L = `${loadSec}s`;
const atLoadEnd = from + loadSec;
const scalarAt = async (expr: string, time: number) => {
  const v = (await query(expr, time))[0]?.value;
  return v === undefined || Number.isNaN(v) ? null : v;
};
const quantile = (q: number, stage: string) =>
  scalar(`histogram_quantile(${q}, sum by (le) (increase(pipeline_latency_ms_bucket{stage="${stage}"}[${W}])))`);

const k6 = a.k6 && existsSync(a.k6) ? (JSON.parse(readFileSync(a.k6, 'utf8')) as K6Summary) : undefined;
interface K6Summary {
  metrics: Record<string, { values: Record<string, number> }>;
}
const k6v = (m: string, f: string) => k6?.metrics[m]?.values[f] ?? null;

const run = {
  label: a.label!,
  workers: Number(a.workers),
  at: new Date(from * 1000).toISOString(),
  durationSec: loadSec,
  ingestMsgPerSec: await scalarAt(`sum(increase(ingest_messages_total[${L}])) / ${loadSec}`, atLoadEnd),
  ingestPeakMsgPerSec: await scalar(`max_over_time(sum(rate(ingest_messages_total[10s]))[${W}:2s])`),
  workerEventsPerSec: await scalarAt(
    `sum(increase(worker_events_total{result!="resolved"}[${L}])) / ${loadSec}`,
    atLoadEnd,
  ),
  /** From the first event to the workers catching up. */
  drainSec: window - loadSec,
  alertsCreated: await scalar(`sum(increase(worker_events_total{result="created"}[${W}]))`),
  deduplicated: await scalar(`sum(increase(worker_events_total{result="deduplicated"}[${W}]))`),
  rejected: await scalar(`sum(increase(ingest_rejected_total[${W}]))`),
  maxLag: await scalar(`max_over_time(max(stream_group_lag{group="workers"})[${W}:2s])`),
  ingestToWorker: { p50: await quantile(0.5, 'ingest_to_worker'), p99: await quantile(0.99, 'ingest_to_worker') },
  ingestToAlert: { p50: await quantile(0.5, 'ingest_to_alert'), p99: await quantile(0.99, 'ingest_to_alert') },
  http: k6 && {
    requests: k6v('http_reqs', 'count'),
    reqPerSec: k6v('http_reqs', 'rate'),
    p50: k6v('http_req_duration', 'p(50)'),
    p99: k6v('http_req_duration', 'p(99)'),
    failedPct: (k6v('http_req_failed', 'rate') ?? 0) * 100,
  },
  machine: `${cpus().length} CPU (${cpus()[0]?.model ?? '?'}), ${Math.round(totalmem() / 2 ** 30)} GB`,
  chart: '',
};

// Chart: ingest msg/s (blue), processed events/s (orange), p99 ingest → alert (red, right axis).
const ingestSeries = await range('sum(rate(ingest_messages_total[10s]))');
const workerSeries = await range('sum(rate(worker_events_total{result!="resolved"}[10s]))');
const p99Series = await range(
  'histogram_quantile(0.99, sum by (le) (rate(pipeline_latency_ms_bucket{stage="ingest_to_alert"}[10s])))',
);
const resultsDir = join(a.dir!, 'results');
mkdirSync(resultsDir, { recursive: true });
const slug = `${run.at.replace(/[:.]/g, '-')}-w${run.workers}`;
run.chart = `results/${slug}.png`;
const maxRate = Math.max(1, ...ingestSeries.map((x) => x[1]), ...workerSeries.map((x) => x[1]));
const maxP99 = Math.max(1, ...p99Series.map((x) => x[1]).filter(Number.isFinite));
writeFileSync(
  join(a.dir!, run.chart),
  chartPng([
    { points: ingestSeries, max: maxRate, rgb: [37, 99, 235] },
    { points: workerSeries, max: maxRate, rgb: [234, 88, 12] },
    { points: p99Series, max: maxP99, rgb: [220, 38, 38] },
  ]),
);
const chartNote = `max ${Math.round(maxRate)} msg/s (left), max p99 ${Math.round(maxP99)} ms (right)`;

const runsFile = join(resultsDir, 'runs.json');
const runs = existsSync(runsFile) ? (JSON.parse(readFileSync(runsFile, 'utf8')) as (typeof run & { chartNote?: string })[]) : [];
runs.push({ ...run, chartNote } as typeof run & { chartNote: string });
writeFileSync(runsFile, `${JSON.stringify(runs, null, 2)}\n`);
writeFileSync(join(a.dir!, 'RESULTS.md'), resultsMd(runs));
console.log(JSON.stringify(run, null, 2));

function resultsMd(rs: (typeof run & { chartNote?: string })[]): string {
  const n = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '–' : v.toFixed(d));
  const rows = rs.map(
    (r) =>
      `| ${r.at.slice(0, 16).replace('T', ' ')} | ${r.label} | ${r.workers} | ${n(r.ingestMsgPerSec)} | ${n(r.ingestPeakMsgPerSec)} | ${n(r.workerEventsPerSec)} | ${n(r.ingestToWorker.p50, 1)} / ${n(r.ingestToWorker.p99, 1)} | ${n(r.ingestToAlert.p50, 1)} / ${n(r.ingestToAlert.p99, 1)} | ${n(r.http?.p99, 1)} | ${n(r.http?.failedPct, 2)}% | ${n(r.maxLag)} |`,
  );
  const charts = rs
    .slice(-6)
    .map((r) => `**${r.label}, ${r.workers} worker(s)** (${r.chartNote ?? ''})\n\n![${r.label}](${r.chart})`);
  return `# Load test results (B1-17)

Measured, not estimated: numbers come from Prometheus (\`ingest_messages_total\`,
\`worker_events_total\`, \`pipeline_latency_ms\`, \`stream_group_lag\`) over each run's window, HTTP
numbers from k6. Generated by \`loadtest/report.ts\`; reproduce with \`bash loadtest/run.sh\`
(see [README](README.md)).

Event mix: 70% duplicates (50 hot trade ids), 25% unique events matching the Rates rule, 5% unknown
shapes. Target from the plan: ≥ 10 000 msg/s into ingest, p99 ingest → alert < 500 ms.

| When (UTC) | Run | Workers | Ingest msg/s (avg) | Ingest msg/s (peak) | Worker events/s | ingest→worker p50 / p99 ms | ingest→alert p50 / p99 ms | HTTP p99 ms | HTTP failed | Max lag |
|---|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

Machine of the last run: ${rs.at(-1)?.machine ?? '–'}.

## Charts

Blue: ingest msg/s, orange: events processed by the workers per second (left axis, shared);
red: p99 ingest → alert (right axis).

${charts.join('\n\n')}
`;
}

/** A dependency-free line chart as PNG (RGB, zlib from node). */
function chartPng(series: { points: [number, number][]; max: number; rgb: [number, number, number] }[]): Buffer {
  const w = 960;
  const h = 320;
  const pad = 24;
  const px = Buffer.alloc(w * h * 3, 255);
  const set = (x: number, y: number, [r, g, b]: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  const line = (x0: number, y0: number, x1: number, y1: number, c: [number, number, number], thick = 2) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps);
      const y = Math.round(y0 + ((y1 - y0) * s) / steps);
      for (let d = 0; d < thick; d++) set(x, y + d, c);
    }
  };
  // Grid: quarters of each axis.
  for (let q = 0; q <= 4; q++) {
    const y = Math.round(pad + ((h - 2 * pad) * q) / 4);
    line(pad, y, w - pad, y, q === 4 ? [120, 120, 120] : [225, 225, 225], 1);
  }
  line(pad, pad, pad, h - pad, [120, 120, 120], 1);
  line(w - pad, pad, w - pad, h - pad, [120, 120, 120], 1);
  const t0 = from;
  const t1 = Math.max(to, from + 1);
  for (const s of series) {
    let prev: [number, number] | undefined;
    for (const [t, v] of s.points) {
      if (!Number.isFinite(v)) {
        prev = undefined;
        continue;
      }
      const x = Math.round(pad + ((w - 2 * pad) * (t - t0)) / (t1 - t0));
      const y = Math.round(h - pad - ((h - 2 * pad) * Math.min(v, s.max)) / s.max);
      if (prev) line(prev[0], prev[1], x, y, s.rgb);
      prev = [x, y];
    }
  }
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
