import type { Condition, Rule } from '@alerting/contracts';
import { compileCondition, type Predicate, type RuleTarget } from './compile.ts';

export interface CompiledRule {
  rule: Rule;
  test: Predicate;
}

export interface RuleEngine {
  readonly rules: CompiledRule[];
  /** Enabled rules whose scope and condition match, in load order. */
  match(event: RuleTarget): CompiledRule[];
  /** Rules whose scope admits the event (before the condition is checked). */
  candidates(event: RuleTarget): CompiledRule[];
}

const inScope = (rule: Rule, e: RuleTarget) =>
  (!rule.scope?.sourceIds?.length || rule.scope.sourceIds.includes(e.sourceId)) &&
  (!rule.scope?.schemaIds?.length || rule.scope.schemaIds.includes(e.schemaId));

/**
 * Compiles enabled rules and indexes them by scope: sourceIds first, else schemaIds, else
 * "all events". Immutable — on `config:changed` build a new engine and swap the reference.
 */
export function createEngine(rules: Rule[]): RuleEngine {
  const compiled = rules
    .filter((r) => r.enabled)
    .map((rule) => ({ rule, test: compileCondition(rule.condition) }));
  const order = new Map(compiled.map((c, i) => [c, i]));

  const global: CompiledRule[] = [];
  const bySource = new Map<string, CompiledRule[]>();
  const bySchema = new Map<string, CompiledRule[]>();
  const add = (index: Map<string, CompiledRule[]>, key: string, c: CompiledRule) => {
    const list = index.get(key);
    if (list) list.push(c);
    else index.set(key, [c]);
  };
  for (const c of compiled) {
    const { sourceIds, schemaIds } = c.rule.scope ?? {};
    if (sourceIds?.length) sourceIds.forEach((id) => add(bySource, id, c));
    else if (schemaIds?.length) schemaIds.forEach((id) => add(bySchema, id, c));
    else global.push(c);
  }

  const candidates = (e: RuleTarget): CompiledRule[] => {
    const scoped = [...(bySource.get(e.sourceId) ?? []), ...(bySchema.get(e.schemaId) ?? [])];
    if (scoped.length === 0) return global;
    return [...global, ...scoped.filter((c) => inScope(c.rule, e))].sort(
      (a, b) => order.get(a)! - order.get(b)!,
    );
  };

  return {
    rules: compiled,
    candidates,
    match: (e) => candidates(e).filter((c) => c.test(e)),
  };
}

export interface PreviewResult<E> {
  matched: number;
  total: number;
  /** First matching events, for "would catch X of N" in the rule editor. */
  examples: E[];
}

/** Runs a condition (or a rule's condition) over sample events, e.g. `events:recent:{orgId}`. */
export function preview<E extends RuleTarget>(
  ruleOrCondition: Pick<Rule, 'condition'> | Condition,
  events: E[],
  maxExamples = 5,
): PreviewResult<E> {
  const condition = 'condition' in ruleOrCondition ? ruleOrCondition.condition : ruleOrCondition;
  const test = compileCondition(condition);
  const examples: E[] = [];
  let matched = 0;
  for (const e of events) {
    if (!test(e)) continue;
    matched++;
    if (examples.length < maxExamples) examples.push(e);
  }
  return { matched, total: events.length, examples };
}
