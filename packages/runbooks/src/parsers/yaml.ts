import yaml from 'js-yaml';
import { z } from 'zod';
import type { RunbookStep } from '@alerting/contracts';
import type { ParsedRunbook } from '../types.ts';

// --- Canonical format (packages/contracts RunbookStep) ---
const CanonicalStepSchema = z.object({
  id: z.string(),
  kind: z.enum(['manual', 'check', 'action', 'link', 'read']),
  text: z.string(),
  action: z.object({ type: z.string(), params: z.record(z.string(), z.unknown()) }).optional(),
  approval: z.enum(['none', 'required']).default('none'),
  if: z.string().optional(),
  url: z.string().optional(),
});

// --- Shorthand format (Appendix C fixtures) ---
// e.g. { check: "Is healthy?", action: http_get, url: "..." }
// e.g. { action: retry_workflow, workflowId: "{{x}}", approval: none }
// e.g. { if: "retry fails twice", action: escalate, team: counterparty, approval: required }
const ACTION_PARAM_EXCLUDE = new Set(['check', 'action', 'approval', 'if', 'url', 'id', 'kind', 'text']);

function normalizeStep(raw: unknown, idx: number): RunbookStep | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // Try canonical format first
  const canonical = CanonicalStepSchema.safeParse(obj);
  if (canonical.success) return canonical.data;

  // Shorthand: derive kind + text + action from shorthand keys
  let kind: RunbookStep['kind'] = 'manual';
  let text: string;
  let action: RunbookStep['action'];
  const approval = obj['approval'] === 'required' ? 'required' : 'none';
  const ifCond = typeof obj['if'] === 'string' ? obj['if'] : undefined;
  const url = typeof obj['url'] === 'string' ? obj['url'] : undefined;

  if (typeof obj['check'] === 'string') {
    kind = 'check';
    text = obj['check'];
    if (typeof obj['action'] === 'string') {
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (!ACTION_PARAM_EXCLUDE.has(k) && k !== 'check') params[k] = v;
      }
      action = { type: obj['action'], params };
    }
  } else if (typeof obj['action'] === 'string') {
    kind = 'action';
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!ACTION_PARAM_EXCLUDE.has(k)) params[k] = v;
    }
    action = { type: obj['action'], params };
    text = typeof obj['text'] === 'string' ? obj['text'] : `Run ${obj['action']}`;
  } else if (typeof obj['link'] === 'string') {
    kind = 'link';
    text = obj['link'];
  } else if (typeof obj['read'] === 'string') {
    kind = 'read';
    text = obj['read'];
  } else {
    // fallback: manual step if 'text' present
    if (typeof obj['text'] === 'string') {
      text = obj['text'];
    } else {
      return null;
    }
  }

  return {
    id: typeof obj['id'] === 'string' ? obj['id'] : `step-${idx}`,
    kind,
    text,
    action,
    approval,
    if: ifCond,
    url,
  };
}

const RawRunbookSchema = z.object({
  runbook: z.string().optional(),
  name: z.string().optional(),
  matches: z.unknown().optional(),
  steps: z.array(z.unknown()),
});

export function parseYaml(source: string): ParsedRunbook {
  const warnings: string[] = [];
  let raw: unknown;

  try {
    raw = yaml.load(source);
  } catch (err) {
    throw new Error(`YAML parse error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  const parsed = RawRunbookSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid runbook structure: ${parsed.error.message}`);
  }

  const steps: RunbookStep[] = [];

  for (let i = 0; i < parsed.data.steps.length; i++) {
    const step = normalizeStep(parsed.data.steps[i], i);
    if (step) {
      steps.push(step);
    } else {
      warnings.push(`Step ${i + 1} could not be parsed, skipping`);
    }
  }

  return {
    name: parsed.data.name ?? parsed.data.runbook,
    matchesRaw: parsed.data.matches,
    steps,
    warnings,
  };
}
