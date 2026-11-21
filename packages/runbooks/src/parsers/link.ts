import type { ParsedRunbook } from '../types.ts';

export function parseLink(url: string): ParsedRunbook {
  return {
    steps: [
      {
        id: 'link-0',
        kind: 'link',
        text: `Open runbook: ${url}`,
        approval: 'none',
        url,
      },
    ],
    warnings: [],
  };
}
