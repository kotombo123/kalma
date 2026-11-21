/** Extension points (out of scope now — see implementation_plan.md §1.2). */
import type { Mapping, SchemaInfo } from './sources.ts';
import type { Rule, Condition } from './rules.ts';
import type { RunbookStep } from './alerts.ts';

/** AI fallback (hidden behind FEATURE_AI). */
export interface Suggester {
  suggestMapping(schema: SchemaInfo): Promise<Partial<Mapping> | null>;
  textToCondition(text: string): Promise<Condition | null>;
  textToRunbookSteps(text: string): Promise<RunbookStep[] | null>;
}

export interface Suggestion {
  id: string;
  kind: 'noisy_rule' | 'missing_runbook' | 'mapping' | 'other';
  targetId: string;
  text: string;
  patch?: Partial<Rule>;
}

/** Improvement suggestions (table `suggestions`, not implemented). */
export interface SuggestionProvider {
  suggest(orgId: string): Promise<Suggestion[]>;
}
