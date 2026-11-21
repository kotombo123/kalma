import yaml from 'js-yaml';
import type { RunbookStep } from '@alerting/contracts';
import type { ParsedRunbook } from '../types.ts';

const ACTION_BLOCK_RE = /```action\n([\s\S]*?)```/g;
const NUMBERED_ITEM_RE = /^\d+\.\s+(.+)$/;
const APPROVAL_PHRASES = ['needs approval', 'wymaga zatwierdzenia', 'requires approval'];
const HIGH_RISK_RE = /restart|delete|drop|force|overwrite|roll.?back/i;

export function parseMarkdown(source: string): ParsedRunbook {
  const warnings: string[] = [];
  const steps: RunbookStep[] = [];
  let stepIndex = 0;

  const actionBlocks = new Map<string, RunbookStep>();
  const placeholders: string[] = [];

  const processedSource = source.replace(ACTION_BLOCK_RE, (_match, blockYaml: string) => {
    const placeholder = `__ACTION_BLOCK_${stepIndex}__`;
    const id = `action-${stepIndex++}`;
    try {
      const raw = yaml.load(blockYaml) as Record<string, unknown>;
      const hasApproval = APPROVAL_PHRASES.some((p) => source.toLowerCase().includes(p));
      actionBlocks.set(placeholder, {
        id,
        kind: 'action',
        text: typeof raw['text'] === 'string' ? raw['text'] : id,
        action: {
          type: typeof raw['type'] === 'string' ? raw['type'] : 'unknown',
          params: (raw['params'] as Record<string, unknown>) ?? {},
        },
        approval: hasApproval ? 'required' : 'none',
      });
    } catch (err) {
      warnings.push(`Action block ${id} parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
    placeholders.push(placeholder);
    return placeholder;
  });

  const lines = processedSource.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    const actionPlaceholderMatch = trimmed.match(/^__ACTION_BLOCK_\d+__$/);
    if (actionPlaceholderMatch) {
      const block = actionBlocks.get(trimmed);
      if (block) steps.push(block);
      continue;
    }

    const numbered = trimmed.match(NUMBERED_ITEM_RE);
    if (numbered) {
      const text = numbered[1] ?? '';
      const hasApproval = APPROVAL_PHRASES.some((p) => text.toLowerCase().includes(p));
      const isHighRisk = HIGH_RISK_RE.test(text);
      steps.push({
        id: `step-${stepIndex++}`,
        kind: 'manual',
        text,
        approval: hasApproval || isHighRisk ? 'required' : 'none',
      });
    }
  }

  const titleMatch = source.match(/^#\s+(.+)$/m);

  return {
    name: titleMatch?.[1],
    steps,
    warnings,
  };
}
