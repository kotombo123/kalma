import type { RunbookStep } from '@alerting/contracts';
import type { ParsedRunbook } from '../types.ts';

const CHECKLIST_ITEM_RE = /^-\s*\[\s*[ x]?\s*\]\s*(.+)$/im;
const CHECKLIST_ITEMS_RE = /^-\s*\[\s*[ x]?\s*\]\s*(.+)$/gim;

export function isChecklist(source: string): boolean {
  return CHECKLIST_ITEM_RE.test(source);
}

export function parseChecklist(source: string): ParsedRunbook {
  const steps: RunbookStep[] = [];
  let i = 0;
  let match: RegExpExecArray | null;

  while ((match = CHECKLIST_ITEMS_RE.exec(source)) !== null) {
    steps.push({
      id: `check-${i++}`,
      kind: 'manual',
      text: (match[1] ?? '').trim(),
      approval: 'none',
    });
  }

  const titleMatch = source.match(/^#\s+(.+)$/m);

  return {
    name: titleMatch?.[1],
    steps,
    warnings: [],
  };
}
