// Auto-discovery: importing these files registers them in the registry
import './types/http-get.js';
import './types/http-post.js';
import './types/retry-workflow.js';
import './types/restart-service.js';
import './types/open-ticket.js';
import './types/escalate.js';
import './types/notify-team.js';

export { registerAction, getAction, listActions } from './registry.ts';
export type { ActionType, ActionContext, ActionResult, ActionRisk } from './registry.ts';
