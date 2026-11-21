import { z } from 'zod';
import { registerAction } from '../registry.ts';

const params = z.object({
  workflowId: z.string().min(1),
  reason: z.string().optional(),
  timeoutMs: z.number().int().min(1).default(10000),
});

registerAction({
  name: 'retry_workflow',
  risk: 'low',
  title: 'Retry workflow',
  params,
  async execute(p, ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), p.timeoutMs);
    try {
      const res = await ctx.fetch(
        `http://demo-systems:3002/workflows/${encodeURIComponent(p.workflowId)}/retry`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: p.reason ?? 'alert auto-retry', alertId: ctx.alert.id }),
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
