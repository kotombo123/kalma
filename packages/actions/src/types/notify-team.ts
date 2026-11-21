import { z } from 'zod';
import { registerAction } from '../registry.ts';

const params = z.object({
  teamId: z.string().min(1),
  message: z.string().min(1),
});

registerAction({
  name: 'notify_team',
  risk: 'low',
  title: 'Notify team',
  params,
  async execute(p, ctx) {
    ctx.logger.info('Team notification triggered', { teamId: p.teamId, message: p.message });
    return { ok: true, output: { notified: true, teamId: p.teamId } };
  },
});
