import { z } from 'zod';
import { registerAction } from '../registry.ts';

const params = z.object({
  message: z.string().min(1),
  alertId: z.string(),
});

registerAction({
  name: 'escalate',
  risk: 'high',
  title: 'Escalate alert',
  params,
  async execute(p, ctx) {
    ctx.logger.info('Escalation triggered', { alertId: p.alertId, message: p.message });
    return { ok: true, output: { escalated: true, alertId: p.alertId } };
  },
});
