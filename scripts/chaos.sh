#!/usr/bin/env bash
# chaos.sh — B2-07 resilience test helper
# Usage:
#   scripts/chaos.sh mailpit stop      # stop Mailpit (simulate SMTP outage)
#   scripts/chaos.sh mailpit start     # bring it back
#   scripts/chaos.sh all stop          # stop all external services
#   scripts/chaos.sh all start         # restore all external services
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.yml}"
ACTION="${2:-stop}"
TARGET="${1:-mailpit}"

case "$TARGET" in
  mailpit)
    SERVICES="mailpit"
    ;;
  redis)
    SERVICES="redis"
    ;;
  all)
    SERVICES="mailpit redis"
    ;;
  *)
    echo "Unknown target: $TARGET. Use: mailpit | redis | all" >&2
    exit 1
    ;;
esac

case "$ACTION" in
  stop)
    echo "[chaos] stopping: $SERVICES"
    docker compose -f "$COMPOSE_FILE" stop $SERVICES
    ;;
  start)
    echo "[chaos] starting: $SERVICES"
    docker compose -f "$COMPOSE_FILE" start $SERVICES
    ;;
  *)
    echo "Unknown action: $ACTION. Use: stop | start" >&2
    exit 1
    ;;
esac
