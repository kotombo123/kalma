import { z } from 'zod';
import { registerAction } from '../registry.ts';

const params = z.object({
  url: z.string().url(),
  body: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().min(1).default(10000),
});

registerAction({
  name: 'http_post',
  risk: 'low',
  title: 'HTTP POST action',
  params,
  async execute(p, ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), p.timeoutMs);
    try {
      const res = await ctx.fetch(p.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...p.headers },
        body: JSON.stringify(p.body ?? {}),
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
