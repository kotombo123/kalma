# Kalma

An alerting platform that turns events from any source (HTTP webhook, Kafka, log file, URL polling) into alerts, routes them to the right teams and on-call engineers, suggests a runbook with pre-filled values, and shows a graph of alert flows.

```
source → ingest → Redis stream → worker (parsing, schema, rules, dedup)
       → alert → notifier (on-call, channels, runbook, escalation) → UI / email / Telegram / Teams / …
```

## Requirements

- **Node.js ≥ 22**
- **pnpm 11** (`corepack enable` picks up the version from `package.json`)
- **Docker** with Docker Compose
- Free ports: 3000–3003, 5173, 5432, 6379, 19092, 8080, 1025, 8025, 9090

## Quick start (recommended: infra in Docker, apps local)

```bash
# 1. Config — defaults work out of the box
cp .env.example .env

# 2. Infrastructure: Postgres, Redis, Redpanda (Kafka), Mailpit, Prometheus, Grafana
docker compose -f infra/docker-compose.yml up -d

# 3. Dependencies, database schema and demo data
pnpm install
pnpm db:migrate
pnpm seed
pnpm seed:history   # optional: 14 days of alert history for the graph and stats screens

# 4. All apps in watch mode
pnpm dev
```

Open **http://localhost:5173** and log in:

| Login | Password | Role |
|---|---|---|
| `admin@acme.test` | `demo` | org admin |
| `anna@acme.test` | `demo` | member of Settlements and Payments |
| `sam@acme.test` | `demo` | Settlements lead |

All seed users share the password `demo`. The UI defaults to **English**; switch to Polish via the user menu (top-right corner).

## Alternative: everything in containers

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml --profile apps up -d --build
docker compose -f infra/docker-compose.yml --profile apps exec api pnpm seed
```

The `migrate` service runs migrations automatically. The first image build (`infra/Dockerfile`, one image for all apps) takes a few minutes.

## Service URLs

| Service | URL |
|---|---|
| UI (web) | http://localhost:5173 |
| API + OpenAPI docs | http://localhost:3000, http://localhost:3000/docs |
| Ingest (source webhooks) | http://localhost:3001 |
| Demo systems (simulated bank systems) | http://localhost:3002 |
| Mailpit (sent emails, Approve links) | http://localhost:8025 |
| Grafana (dashboards, no login) | http://localhost:3003 |
| Prometheus | http://localhost:9090 |
| Redpanda Console (Kafka) | http://localhost:8080 |

## Demo: end-to-end scenarios

With `pnpm dev` running:

```bash
bash scripts/scenario.sh settlement-timeout     # alert → runbook → email approval → escalation → auto-resolve
bash scripts/scenario.sh payments-error-spike
bash scripts/scenario.sh trade-rejected
bash scripts/scenario.sh pricing-latency        # log line in file → tail → alert
bash scripts/scenario.sh recover                # source signals recovery → alert closes
```

The alert appears live in the **Alerts** tab. The Approve email link is in Mailpit.

Other tools:

```bash
pnpm send-event events/alertmanager-firing.json [http|kafka|file|poll]  # send a sample event to ingest
pnpm emit-alert                                                          # insert an alert directly (notifier test)
pnpm emit-ui-events                                                      # random UI events (frontend test)
bash scripts/chaos.sh mailpit stop|start                                 # simulate SMTP failure
bash loadtest/run.sh                                                     # load test → loadtest/RESULTS.md
```

## Configuration:

All variables are documented in `.env.example`. Key optional ones:

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Real Telegram bot — create one via @BotFather. Without it, Telegram is disabled. Users link their account in **My notifications → Connect Telegram**. |
| `TEAMS_WEBHOOK_URL` | Global fallback Teams webhook. Users can also paste their own channel webhook in **My notifications**. |
| `JWT_SECRET` | Required in `NODE_ENV=production` — `openssl rand -hex 32` |

SMS and phone channels have no provider yet.

Rules can also live in `config/rules/*.yaml` — the worker hot-syncs them to the database.

## Connecting notification channels

**Telegram**
1. Set `TELEGRAM_BOT_TOKEN` in `.env` and restart the notifier.
2. In Kalma: user menu → **My notifications** → **Connect Telegram** → send the generated command to the bot.

**Microsoft Teams**
1. In Teams: channel → `...` → Manage channel → Connectors → Incoming Webhook → Configure → copy URL.
2. In Kalma: user menu → **My notifications** → paste the URL under **Microsoft Teams**.

**Email**
Works out of the box via Mailpit (local catcher at http://localhost:8025). Set a real SMTP server for production (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`).

## Linting, type checking, tests (same as CI)

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Integration tests (testcontainers) require a running Docker daemon

## Known issues with `pnpm dev`

- **Notifier crashes with `EADDRINUSE :::9100`**: the worker and notifier both want the same metrics port. Run the notifier separately:
  ```bash
  cd apps/notifier && METRICS_PORT=9101 pnpm dev
  ```
- **Ingest logs `ENOTFOUND demo-systems`**: the seeded poll source uses a Docker network hostname. Only polling is affected locally — HTTP webhook, Kafka and file tail work fine.

## Repository structure

| Directory | Contents |
|---|---|
| `apps/api` | REST API + WebSocket for the UI |
| `apps/web` | Frontend (React + Vite + Tailwind) |
| `apps/ingest` | Event ingestion: HTTP, Kafka, file tail, URL poller |
| `apps/worker` | Parsing, schemas, rules, dedup, alert creation |
| `apps/notifier` | Delivery, channels, runbooks, approvals, escalation |
| `apps/demo-systems` | Simulated bank systems for demos |
| `packages/*` | Shared libraries (contracts, db, rules, parsers, runbooks, channels, on-call) |
| `config/` | File-based rules and runbooks |
| `infra/` | docker-compose, Dockerfile, Prometheus, Grafana |
| `docs/spec/` | Task spec and notes |

For the implementation plan see `implementation_plan.md`. Team workflow and the shared message board (`tools/board`): `AGENTS.md`.
