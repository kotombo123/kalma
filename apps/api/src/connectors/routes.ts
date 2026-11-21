import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { stringify } from 'yaml';
import { z } from 'zod';
import type { Deps } from '../deps.ts';
import { requireAuth, requireOrgAdmin } from '../auth/guards.ts';
import { CONNECTORS_DIR, loadTemplates, repoRoot, TEMPLATES_DIR } from './sync.ts';

/**
 * Connectors (#46): which templates exist and how each connector file is doing.
 * Files are the source of truth; these routes only read (docs/connectors/implementation_plan.md).
 */
export async function connectorRoutes(app: FastifyInstance, deps: Deps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const root = deps.connectors?.root ?? repoRoot();

  r.get(
    '/connectors/templates',
    {
      preHandler: [requireAuth, requireOrgAdmin],
      schema: {
        tags: ['connectors'],
        summary: 'Templates in config/connectors/templates with a ready connector file',
      },
    },
    async () => {
      const { templates, errors } = await loadTemplates(root);
      return {
        dir: TEMPLATES_DIR,
        connectorsDir: CONNECTORS_DIR,
        errors,
        data: [...templates.values()].map(({ meta }) => {
          const settings = Object.fromEntries(
            Object.entries(meta.settings).map(([k, s]) => [k, s.default ?? '']),
          );
          return {
            ...meta,
            exampleFile: stringify({
              connector: `moj-${meta.id.replace(/_/g, '-')}`,
              system: 'Nazwa systemu z Połączonych systemów',
              name: meta.title,
              template: meta.id,
              ...(Object.keys(settings).length && { settings }),
            }),
          };
        }),
      };
    },
  );

  // a file dropped on the screen: checked, then saved to config/connectors/ and synced at once
  r.post(
    '/connectors',
    {
      preHandler: [requireAuth, requireOrgAdmin],
      schema: {
        tags: ['connectors'],
        summary: 'Add or replace a connector file (YAML text); nothing is saved when it is invalid',
        body: z.object({ content: z.string().min(1).max(64_000) }),
      },
    },
    async (req, reply) => {
      if (!deps.connectors)
        return reply
          .code(503)
          .send({ error: { code: 'connectors_off', message: 'Konektory są wyłączone w tym wdrożeniu' } });
      const status = await deps.connectors.accept(req.body.content, req.user.orgId);
      if (!status.ok)
        return reply
          .code(422)
          .send({ error: { code: 'invalid_connector', message: status.error ?? 'Błąd w pliku' }, status });
      return reply.code(201).send(status);
    },
  );

  r.get(
    '/connectors',
    {
      preHandler: [requireAuth, requireOrgAdmin],
      schema: { tags: ['connectors'], summary: 'State of every connector file (last sync result)' },
    },
    async () => ({ enabled: Boolean(deps.connectors), data: deps.connectors?.status() ?? [] }),
  );
}
