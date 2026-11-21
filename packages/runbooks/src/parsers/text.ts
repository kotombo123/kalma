import type { ParsedRunbook } from '../types.ts';

export function parseText(source: string): ParsedRunbook {
  return {
    steps: [
      {
        id: 'text-0',
        kind: 'read',
        text: source.trim(),
        approval: 'none',
      },
    ],
    warnings: [],
  };
}
