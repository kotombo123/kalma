import type { ParsedRunbook } from './types.ts';

export interface RunbookCandidate {
  runbookId: string;
  source: string;
  format: string;
  parsed: ParsedRunbook;
}

export interface MatchContext {
  ruleRunbookId?: string;
  schemaId: string;
  eventType?: string;
  evaluateCondition?: (condition: unknown, event: unknown) => boolean;
}

export function findRunbook(
  candidates: RunbookCandidate[],
  ctx: MatchContext,
): RunbookCandidate | undefined {
  if (ctx.ruleRunbookId) {
    const direct = candidates.find((c) => c.runbookId === ctx.ruleRunbookId);
    if (direct) return direct;
  }

  for (const candidate of candidates) {
    const matchesRaw = candidate.parsed.matchesRaw;
    if (!matchesRaw) continue;
    if (ctx.evaluateCondition) {
      try {
        if (ctx.evaluateCondition(matchesRaw, { schemaId: ctx.schemaId, type: ctx.eventType })) {
          return candidate;
        }
      } catch {
        // skip on eval error
      }
    }
  }

  return undefined;
}
