import type { ActionType } from '@alerting/contracts';

export type { ActionType, ActionContext, ActionResult, ActionRisk } from '@alerting/contracts';

const registry = new Map<string, ActionType>();

export function registerAction<P>(type: ActionType<P>): void {
  registry.set(type.name, type as ActionType);
}

export function getAction(name: string): ActionType | undefined {
  return registry.get(name);
}

export function listActions(): ActionType[] {
  return Array.from(registry.values());
}
