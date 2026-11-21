import { z } from 'zod';
import { registerAction } from '../registry.ts';

const params = z.object({
  title: z.string().min(1),
  severity: z.enum(['critical', 'error', 'warning', 'info']),
  body: z.string().optional(),
  timeoutMs: z.number().int().min(1).default(10000),
});

registerAction({
  name: 'open_ticket',
  risk: 'low',
  title: 'Open incident ticket',
  params,
  async execute(p, ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), p.timeoutMs);
    try {
      const res = await ctx.fetch('http://demo-systems:3002/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: p.title,
          severity: p.severity,
          body: p.body,
          alertId: ctx.alert.id,
        }),
        signal: controller.signal,
      });
      const body = await res.json().catch(() => null);
      return { ok: res.ok, output: body };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  },
});
