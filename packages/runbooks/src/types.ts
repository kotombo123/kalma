import type { RunbookStep } from '@alerting/contracts';

// Re-export canonical types from @alerting/contracts.
export type {
  RunbookStep,
  RunbookFormat,
  Runbook,
  RunbookInstanceStep,
  StepState,
} from '@alerting/contracts';

export interface ParseResult {
  steps: RunbookStep[];
  warnings: string[];
}

export interface ParsedRunbook {
  name?: string;
  /** Raw matches value from source (before converting to Condition). */
  matchesRaw?: unknown;
  steps: RunbookStep[];
  warnings: string[];
}
