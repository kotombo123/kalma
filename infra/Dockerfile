# One image for every app; the `APP` env var picks which one starts (see docker-compose.yml).
# Apps run TypeScript directly with tsx, so there is no build step.
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY e2e ./e2e
# keep only manifests for a cached install layer
RUN find apps packages scripts e2e -mindepth 1 -not -name package.json -not -type d -delete
RUN pnpm install --frozen-lockfile

FROM node:22-alpine
RUN corepack enable
WORKDIR /repo
COPY --from=deps /repo /repo
COPY . .
RUN pnpm install --frozen-lockfile --offline
CMD ["sh", "-c", "exec pnpm --filter @alerting/$APP start"]
