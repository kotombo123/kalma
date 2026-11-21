# Load test (B1-17)

One command, against the stack that is running (`pnpm dev` or docker compose):

```bash
bash loadtest/run.sh                                   # 1000 req/s × 10 events = 10k msg/s for 60 s
RATE=500 BATCH=10 DURATION=30s bash loadtest/run.sh    # lighter
SCENARIO=ramp bash loadtest/run.sh                     # ramp 0 → RATE, then hold
KAFKA_RATE=5000 bash loadtest/run.sh                   # + Kafka producer in parallel
SCALES="1 2 4" bash loadtest/run.sh                    # compose: --scale worker=1/2/4
```

- `http.js`: k6 (runs in Docker, `grafana/k6:0.54.0`), NDJSON batches to `POST /ingest/:sourceId`.
  Mix: 70% duplicates, 25% unique events matching the Rates rule, 5% unknown shapes.
- `kafka-producer.ts`: the same mix to the seed Kafka topic `workflow-events`.
- `report.ts`: reads the run window from Prometheus (ingest msg/s, worker events/s, p50/p99
  `pipeline_latency_ms` per stage, max group lag) and the k6 summary, appends to
  `results/runs.json`, rewrites [RESULTS.md](RESULTS.md) and draws a PNG per run.

Known limit: with `SCALES`, Prometheus scrapes the compose `worker` service by name, so it sees
one instance; latency quantiles then come from that instance only.
