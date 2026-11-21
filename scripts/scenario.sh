#!/usr/bin/env bash
# Usage: scripts/scenario.sh <scenario-name>
# Available: settlement-timeout payments-error-spike trade-rejected pricing-latency recover

set -euo pipefail

SCENARIO=${1:-}
if [[ -z "$SCENARIO" ]]; then
  echo "Usage: $0 <scenario>" >&2
  echo "Available scenarios: settlement-timeout payments-error-spike trade-rejected pricing-latency recover" >&2
  exit 1
fi

DEMO_URL=${DEMO_SYSTEMS_URL:-http://localhost:3002}

echo "Triggering scenario: $SCENARIO"
# Fastify rejects an empty body sent with a JSON content type, so send {}
curl -fsS -X POST "$DEMO_URL/scenarios/$SCENARIO" -H "content-type: application/json" -d '{}' | jq .
