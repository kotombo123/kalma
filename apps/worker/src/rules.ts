import type { Logger } from '@alerting/config';
import { Rule } from '@alerting/contracts';
import { eq, t, type Db } from '@alerting/db';
import { createEngine, type RuleEngine } from '@alerting/rules';
import type { RulePort } from './ports.ts';

/** Enabled rules from Postgres, one engine per org. `reload()` builds new engines and swaps them in. */
export class DbRules implements RulePort {
  private engines = new Map<string, RuleEngine>();

  constructor(
    private readonly db: Db,
    private readonly log?: Logger,
  ) {}

  engineFor(orgId: string): RuleEngine | undefined {
    return this.engines.get(orgId);
  }

  async reload(): Promise<void> {
    const rows = await this.db
      .select({
        id: t.rules.id,
        orgId: t.rules.orgId,
        teamId: t.rules.teamId,
        version: t.rules.version,
        definition: t.rules.definition,
      })
      .from(t.rules)
      .where(eq(t.rules.enabled, true));

    const byOrg = new Map<string, Rule[]>();
    for (const row of rows) {
      // The row's columns win over the stored definition (they are what the API updates).
      const parsed = Rule.safeParse({
        ...row.definition,
        id: row.id,
        orgId: row.orgId,
        teamId: row.teamId,
        version: row.version,
        enabled: true,
      });
      if (!parsed.success) {
        this.log?.warn({ ruleId: row.id, issues: parsed.error.issues }, 'skipping invalid rule');
        continue;
      }
      const list = byOrg.get(row.orgId) ?? [];
      list.push(parsed.data);
      byOrg.set(row.orgId, list);
    }

    // Atomic swap: in-flight batches keep the engines they started with.
    this.engines = new Map([...byOrg].map(([orgId, rules]) => [orgId, createEngine(rules)]));
    this.log?.info({ rules: rows.length, orgs: byOrg.size }, 'rules loaded');
  }
}
