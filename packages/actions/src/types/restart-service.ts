import { z } from 'zod';
import { registerAction } from '../registry.ts';

const params = z.object({
  service: z.string().min(1),
  timeoutMs: z.number().int().min(1).default(15000),
});

registerAction({
  name: 'restart_service',
  risk: 'high',
  title: 'Restart service',
  params,
  async execute(p, ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), p.timeoutMs);
    try {
      const res = await ctx.fetch(
        `http://demo-systems:3002/services/${encodeURIComponent(p.service)}/restart`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alertId: ctx.alert.id }),
          signal: controller.signal,
        },
      );
      const body = await res.json().catch(() => null);
      return { ok: res.ok, output: body };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  },
});
