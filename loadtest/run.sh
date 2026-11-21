#!/usr/bin/env bash
# B1-17: one command for the whole load test.
#   bash loadtest/run.sh                       # against the stack that is running (pnpm dev or compose)
#   SCALES="1 2 4" bash loadtest/run.sh        # compose stack, re-run with 1, 2 and 4 workers
# Knobs: RATE (req/s, default 1000), BATCH (events per request, 10), DURATION (60s),
# SCENARIO (constant|ramp), KAFKA_RATE (msg/s from loadtest/kafka-producer.ts in parallel, 0 = off).
set -euo pipefail
cd "$(dirname "$0")/.."

RATE=${RATE:-1000}
BATCH=${BATCH:-10}
DURATION=${DURATION:-60s}
SCENARIO=${SCENARIO:-constant}
KAFKA_RATE=${KAFKA_RATE:-0}
SCALES=${SCALES:-}
PROM=${PROMETHEUS_URL:-http://localhost:9090}
# k6 runs in Docker; from there the host's ingest is host.docker.internal.
K6_INGEST=${K6_INGEST_URL:-http://host.docker.internal:3001}
K6_IMAGE=grafana/k6:0.54.0
COMPOSE="docker compose -f infra/docker-compose.yml --profile apps"
tsx() { node_modules/.bin/tsx "$@"; }

mkdir -p loadtest/out

lag() {
  curl -s --get "$PROM/api/v1/query" --data-urlencode 'query=max(stream_group_lag{group="workers"})' |
    sed -n 's/.*"value":\[[^,]*,"\([^"]*\)".*/\1/p'
}

one_run() {
  local workers=$1
  local label="http ${RATE} req/s × ${BATCH} (${SCENARIO})"
  [ "$KAFKA_RATE" != 0 ] && label="$label + kafka ${KAFKA_RATE} msg/s"
  echo "== $label, $workers worker(s)"
  local from; from=$(date +%s)

  local kafka_pid=
  if [ "$KAFKA_RATE" != 0 ]; then
    tsx loadtest/kafka-producer.ts --rate "$KAFKA_RATE" --duration "${DURATION%s}" &
    kafka_pid=$!
  fi
  docker run --rm -i --add-host=host.docker.internal:host-gateway \
    -v "$PWD/loadtest:/loadtest" -w / \
    -e INGEST_URL="$K6_INGEST" -e RATE="$RATE" -e BATCH="$BATCH" -e DURATION="$DURATION" \
    -e SCENARIO="$SCENARIO" -e RUN_ID="$from" -e SUMMARY=/loadtest/out/k6-summary.json \
    "$K6_IMAGE" run --quiet /loadtest/http.js || true
  [ -n "$kafka_pid" ] && wait "$kafka_pid"
  local load_end; load_end=$(date +%s)

  # The run ends when the workers have caught up (or after 2 minutes).
  for _ in $(seq 1 120); do
    l=$(lag); [ "${l:-0}" = 0 ] && break; sleep 1
  done
  sleep 6 # one more Prometheus scrape after the last event
  local to; to=$(date +%s)
  tsx loadtest/report.ts --from "$from" --to "$to" --label "$label" --workers "$workers" \
    --load-seconds "$((load_end - from))" \
    --k6 loadtest/out/k6-summary.json --prometheus "$PROM" >/dev/null
  echo "   → loadtest/RESULTS.md"
}

if [ -z "$SCALES" ]; then
  one_run "${WORKERS:-1}"
else
  for n in $SCALES; do
    $COMPOSE up -d --no-recreate --scale worker="$n" worker >/dev/null
    sleep 10 # new workers join the consumer group
    one_run "$n"
  done
fi
tail -n +1 loadtest/RESULTS.md | sed -n '/^| When/,/^$/p'
