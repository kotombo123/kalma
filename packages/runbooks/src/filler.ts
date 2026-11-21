import type { RunbookStep } from '@alerting/contracts';

export interface FillContext {
  renderTemplate: (template: string, data: Record<string, unknown>) => string;
}

export interface FilledStep extends RunbookStep {
  textFilled: string;
  actionFilled?: {
    type: string;
    params: Record<string, unknown>;
  };
  missingFields: string[];
}

const TEMPLATE_VAR_RE = /\{\{([^}]+)\}\}/g;

function extractTemplateVars(template: string): string[] {
  const vars: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(TEMPLATE_VAR_RE.source, 'g');
  while ((match = re.exec(template)) !== null) {
    vars.push((match[1] ?? '').trim().split('|')[0]?.trim() ?? '');
  }
  return vars;
}

function fillParams(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
  render: (t: string, d: Record<string, unknown>) => string,
): { filled: Record<string, unknown>; missing: string[] } {
  const filled: Record<string, unknown> = {};
  const missing: string[] = [];

  for (const [key, val] of Object.entries(params)) {
    if (typeof val === 'string') {
      const vars = extractTemplateVars(val);
      for (const v of vars) {
        if (data[v] === undefined && !v.startsWith('$')) {
          missing.push(v);
        }
      }
      filled[key] = render(val, data);
    } else {
      filled[key] = val;
    }
  }

  return { filled, missing };
}

export function fillStep(
  step: RunbookStep,
  data: Record<string, unknown>,
  ctx: FillContext,
): FilledStep {
  const textFilled = ctx.renderTemplate(step.text, data);
  const missingFields: string[] = [];

  for (const v of extractTemplateVars(step.text)) {
    if (data[v] === undefined && !v.startsWith('$')) {
      missingFields.push(v);
    }
  }

  let actionFilled: FilledStep['actionFilled'];
  if (step.action) {
    const { filled, missing } = fillParams(step.action.params, data, ctx.renderTemplate);
    missingFields.push(...missing);
    actionFilled = { type: step.action.type, params: filled };
  }

  return { ...step, textFilled, actionFilled, missingFields };
}

export function fillRunbook(
  steps: RunbookStep[],
  data: Record<string, unknown>,
  ctx: FillContext,
): FilledStep[] {
  return steps.map((s) => fillStep(s, data, ctx));
}
