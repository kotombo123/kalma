import { z } from 'zod';
import { registerAction } from '../registry.ts';

const params = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1).default(5000),
});

registerAction({
  name: 'http_get',
  risk: 'low',
  title: 'HTTP GET check',
  params,
  async execute(p, ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), p.timeoutMs);
    try {
      const res = await ctx.fetch(p.url, {
        headers: p.headers,
        signal: controller.signal,
      });
      return { ok: res.ok, output: { status: res.status } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  },
});
