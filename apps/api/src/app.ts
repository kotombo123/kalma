import Fastify, { type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { metrics } from '@alerting/config';
import type { AppConfig, Deps } from './deps.ts';
import { HttpError } from './lib/errors.ts';
import { ACCESS_TTL_SEC } from './auth/session.ts';
import { authRoutes } from './auth/routes.ts';
import { inviteRoutes } from './invites/routes.ts';
import { memberRoutes } from './org/members.ts';
import { teamRoutes } from './org/teams.ts';
import { systemRoutes } from './org/systems.ts';
import { sourceRoutes } from './org/sources.ts';
import { schemaRoutes } from './schemas/routes.ts';
import { ruleRoutes } from './rules/routes.ts';
import { alertRoutes } from './alerts/routes.ts';
import { graphRoutes } from './graph/routes.ts';
import { runbookRoutes } from './runbooks/routes.ts';
import { meRoutes } from './me/routes.ts';
import { oncallRoutes } from './oncall/routes.ts';
import { statusRoutes } from './system/routes.ts';
import { connectorRoutes } from './connectors/routes.ts';
import websocket from '@fastify/websocket';
import { Hub } from './ws/hub.ts';
import { wsRoutes } from './ws/routes.ts';

declare module 'fastify' {
  interface FastifyInstance {
    appConfig: AppConfig;
    hub: Hub;
  }
}

/** Builds the API without listening — used by index.ts and tests. */
export async function buildApp(deps: Deps, opts: FastifyServerOptions = {}) {
  const app = Fastify({ trustProxy: true, ...opts });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('appConfig', deps.config);

  // Swagger UI needs its own CSP (inline styles); everything else keeps helmet's strict default.
  await app.register(helmet, { contentSecurityPolicy: false });
  app.addHook('onSend', async (req, reply) => {
    if (!req.url.startsWith('/docs')) {
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    }
  });
  // F-10: OpenAPI from the Zod route schemas; UI at /docs, JSON at /docs/json
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Kalma API',
        version: '1.0.0',
        description:
          'REST API of the alerting console. Authenticate with POST /auth/login and send the access token as `Authorization: Bearer <token>`. Errors: `{ error: { code, message, issues? } }`. Lists: `{ data, nextCursor }` with `?limit=&cursor=`.',
      },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
  await app.register(cookie);
  // Fixed algorithm: tokens with any other `alg` (incl. "none") are rejected (OWASP A07).
  await app.register(jwt, {
    secret: deps.config.jwtSecret,
    sign: { algorithm: 'HS256', expiresIn: ACCESS_TTL_SEC },
    verify: { algorithms: ['HS256'] },
  });
  // Opt-in per route (`config.rateLimit`); counters in Redis so limits hold across API instances.
  await app.register(rateLimit, {
    global: false,
    redis: deps.redis,
    nameSpace: 'ratelimit:api:',
    enableDraftSpec: false,
    skipOnError: true,
    ...(deps.config.rateLimit ? {} : { allowList: () => true }),
  });

  app.setErrorHandler((error, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      // same issue shape as every other error: { path: (string | number)[], message }
      const issues = error.validation.map((v) => {
        const zodPath = (v.params as { issue?: { path?: (string | number)[] } }).issue?.path;
        return {
          path: [
            error.validationContext ?? 'body',
            ...(zodPath ?? v.instancePath.split('/').filter(Boolean)),
          ],
          message: v.message ?? 'Invalid value',
        };
      });
      return reply.code(400).send({ error: { code: 'validation', message: 'Invalid request', issues } });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.issues && { issues: error.issues }) },
      });
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err: error }, 'request failed');
      return reply.code(500).send({ error: { code: 'internal', message: 'Internal error' } });
    }
    const code = status === 429 ? 'rate_limited' : 'bad_request';
    return reply.code(status).send({ error: { code, message: (error as Error).message } });
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } }),
  );

  app.get('/health', async () => ({ ok: true }));
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics().contentType);
    return metrics().metrics();
  });

  await app.register(authRoutes, deps);
  await app.register(inviteRoutes, deps);
  await app.register(memberRoutes, deps);
  await app.register(teamRoutes, deps);
  await app.register(systemRoutes, deps);
  await app.register(sourceRoutes, deps);
  await app.register(schemaRoutes, deps);
  await app.register(ruleRoutes, deps);
  await app.register(alertRoutes, deps);
  await app.register(graphRoutes, deps);
  await app.register(runbookRoutes, deps);
  await app.register(meRoutes, deps);
  await app.register(oncallRoutes, deps);
  await app.register(statusRoutes, deps);
  await app.register(connectorRoutes, deps);

  const hub = new Hub(deps.db, deps.redis, app.log);
  await hub.start();
  app.decorate('hub', hub);
  app.addHook('onClose', async () => hub.stop());
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  await app.register(async (scope) => wsRoutes(scope, hub));
  return app;
}
