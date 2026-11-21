import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  CONFIG_CHANGED,
  newId,
  prom,
  metrics,
  RULES_SYNC_LEASE,
  type Logger,
  type Redis,
} from '@alerting/config';
import { ConfigChanged, Rule, RuleFile, type RoutingTarget } from '@alerting/contracts';
import { and, eq, sql, t, type Db } from '@alerting/db';
import { validateRule } from '@alerting/rules';
import { parse as parseYaml } from 'yaml';

/** Where rules live relative to the repo root, and the prefix stored in `rules.file_path`. */
export const RULES_DIR = 'config/rules';
const RULE_FILE = /\.ya?ml$/;

const syncTotal = new prom.Counter({
  name: 'rules_sync_files_total',
  help: 'YAML rule files synced into Postgres',
  labelNames: ['result'] as const,
  registers: [metrics()],
});

export type SyncResult =
  | { file: string; result: 'created' | 'updated' | 'unchanged' | 'removed'; id: string; version?: number }
  | { file: string; result: 'invalid'; error: string; id?: string }
  | { file: string; result: 'ignored' };

/** Nearest directory above `from` with `pnpm-workspace.yaml` (works from `apps/worker` and `/repo`). */
export function repoRoot(from = process.cwd()): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** References by name in a rule file → ids of one org, or a readable error. */
interface Directory {
  orgId: string;
  team(keyOrName: string): string | undefined;
  user(email: string): string | undefined;
  runbook(name: string): string | undefined;
}

/**
 * B1-15: rule files in `config/rules/*.yaml` → `rules` (`origin = 'file'`). A file is matched to
 * its rule by `file_path`. A valid change writes a new version and publishes `config:changed`;
 * an invalid file keeps the last good version running and shows the problem in
 * `rules.file_error`. A removed file disables its rule.
 */
export class RulesSync {
  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly dir: string,
    private readonly log?: Logger,
  ) {}

  /** Every rule file in the directory, plus rules whose file is gone. */
  async syncAll(): Promise<SyncResult[]> {
    const files = await this.ruleFiles();
    const results: SyncResult[] = [];
    for (const f of files.sort()) results.push(await this.syncFile(f));

    if (!files.length) return results; // see doSyncFile: nothing is disabled then
    const present = new Set(files.map((f) => `${RULES_DIR}/${f}`));
    const known = await this.db
      .select({ filePath: t.rules.filePath })
      .from(t.rules)
      .where(and(eq(t.rules.origin, 'file'), eq(t.rules.enabled, true)));
    for (const { filePath } of known) {
      if (filePath?.startsWith(`${RULES_DIR}/`) && !present.has(filePath)) {
        results.push(await this.syncFile(filePath.slice(RULES_DIR.length + 1)));
      }
    }
    return results;
  }

  private async ruleFiles(): Promise<string[]> {
    return existsSync(this.dir) ? (await readdir(this.dir)).filter((f) => RULE_FILE.test(f)) : [];
  }

  async syncFile(file: string): Promise<SyncResult> {
    const r = await this.doSyncFile(file).catch((e: unknown): SyncResult => ({
      file,
      result: 'invalid',
      error: String(e),
    }));
    if (r.result !== 'ignored') syncTotal.inc({ result: r.result });
    if (r.result === 'invalid') this.log?.warn({ file, error: r.error }, 'rule file invalid');
    else if (r.result !== 'unchanged' && r.result !== 'ignored') this.log?.info(r, 'rule file synced');
    return r;
  }

  private async doSyncFile(file: string): Promise<SyncResult> {
    if (!RULE_FILE.test(file) || file.includes('/')) return { file, result: 'ignored' };
    const filePath = `${RULES_DIR}/${file}`;
    const existing = await this.db
      .select({
        id: t.rules.id,
        orgId: t.rules.orgId,
        version: t.rules.version,
        enabled: t.rules.enabled,
        definition: t.rules.definition,
        fileError: t.rules.fileError,
      })
      .from(t.rules)
      .where(and(eq(t.rules.origin, 'file'), eq(t.rules.filePath, filePath)));

    let text: string;
    try {
      text = await readFile(join(this.dir, file), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      // A missing or emptied directory (volume not mounted, a git checkout in progress) is not
      // "every rule was deleted": keep the rules as they are.
      if (!(await this.ruleFiles()).length) {
        if (existing.some((x) => x.enabled))
          this.log?.warn({ file, dir: this.dir }, 'rules directory missing or empty, rule kept');
        return { file, result: 'ignored' };
      }
      // The file is gone: its rules stop matching, history stays.
      for (const row of existing.filter((x) => x.enabled)) {
        await this.db
          .update(t.rules)
          .set({ enabled: false, fileError: 'The file was removed', updatedAt: sql`now()` })
          .where(eq(t.rules.id, row.id));
        await this.changed(row.orgId, row.id, row.version);
      }
      return existing[0] ? { file, result: 'removed', id: existing[0].id } : { file, result: 'ignored' };
    }

    const current = existing[0];
    const built = await this.build(text, current?.orgId);
    if (!built.ok) {
      if (current && current.fileError !== built.error) {
        await this.db
          .update(t.rules)
          .set({ fileError: built.error, updatedAt: sql`now()` })
          .where(eq(t.rules.id, current.id));
        await this.changed(current.orgId, current.id, current.version);
      }
      return { file, result: 'invalid', error: built.error, ...(current && { id: current.id }) };
    }

    const rule = built.rule;
    if (!current) {
      const id = newId();
      const definition = Rule.parse({ ...rule, id, version: 1 });
      await this.db.transaction(async (tx) => {
        await tx.insert(t.rules).values({
          id,
          orgId: definition.orgId,
          teamId: definition.teamId,
          name: definition.name,
          enabled: definition.enabled,
          version: 1,
          definition,
          origin: 'file',
          filePath,
        });
        await tx.insert(t.ruleVersions).values({ ruleId: id, version: 1, definition });
      });
      await this.changed(definition.orgId, id, 1);
      return { file, result: 'created', id, version: 1 };
    }

    const same = sameRule(current.definition, rule);
    if (same && current.fileError === null) return { file, result: 'unchanged', id: current.id };
    const version = same ? current.version : current.version + 1;
    const definition = Rule.parse({ ...rule, id: current.id, orgId: current.orgId, version });
    await this.db.transaction(async (tx) => {
      await tx
        .update(t.rules)
        .set({
          teamId: definition.teamId,
          name: definition.name,
          enabled: definition.enabled,
          version,
          definition,
          fileError: null,
          updatedBy: null,
          updatedAt: sql`now()`,
        })
        .where(eq(t.rules.id, current.id));
      if (!same) await tx.insert(t.ruleVersions).values({ ruleId: current.id, version, definition });
    });
    await this.changed(current.orgId, current.id, version);
    return { file, result: 'updated', id: current.id, version };
  }

  /** YAML → structure → references → B1-07 validation. */
  private async build(
    text: string,
    knownOrg?: string,
  ): Promise<{ ok: true; rule: Rule } | { ok: false; error: string }> {
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (e) {
      return { ok: false, error: `YAML: ${(e as Error).message.split('\n')[0]}` };
    }
    const f = RuleFile.safeParse(raw);
    if (!f.success) return { ok: false, error: issuesText(f.error.issues) };

    const dir = await this.directory(f.data.orgId ?? knownOrg);
    if (typeof dir === 'string') return { ok: false, error: dir };

    const problems: string[] = [];
    const teamId = f.data.teamId ?? (f.data.team ? dir.team(f.data.team) : undefined);
    if (!teamId) problems.push(`team: unknown team "${f.data.team ?? ''}"`);
    const targets = f.data.routing.targets.flatMap((x, i): RoutingTarget[] => {
      if ('teamId' in x || 'userId' in x) return [x];
      const id = 'team' in x ? dir.team(x.team) : dir.user(x.email);
      if (!id) {
        problems.push(
          `routing.targets[${i}]: unknown ${'team' in x ? `team "${x.team}"` : `user "${x.email}"`}`,
        );
        return [];
      }
      return 'team' in x ? [{ type: x.type, teamId: id }] : [{ type: 'user', userId: id }];
    });
    const runbookId = f.data.runbook ? dir.runbook(f.data.runbook) : f.data.runbookId;
    if (f.data.runbook && !runbookId) problems.push(`runbook: unknown runbook "${f.data.runbook}"`);
    if (problems.length) return { ok: false, error: problems.join('; ') };

    const { team: _team, runbook: _runbook, ...rest } = f.data;
    const v = validateRule({
      ...rest,
      id: f.data.id ?? 'pending',
      orgId: dir.orgId,
      teamId,
      ...(runbookId && { runbookId }),
      routing: { ...f.data.routing, targets },
    });
    if (!v.ok) return { ok: false, error: v.error.map((i) => `${i.path}: ${i.message}`).join('; ') };
    return { ok: true, rule: v.value };
  }

  /** The org a file belongs to: its `orgId`, the org its rule already has, or the only org. */
  private async directory(orgId?: string): Promise<Directory | string> {
    if (!orgId) {
      const orgs = await this.db.select({ id: t.orgs.id }).from(t.orgs).limit(2);
      if (orgs.length !== 1) return 'orgId: required when there is more than one organisation';
      orgId = orgs[0]!.id;
    }
    const [teams, users, runbooks] = await Promise.all([
      this.db.select({ id: t.teams.id, name: t.teams.name }).from(t.teams).where(eq(t.teams.orgId, orgId)),
      this.db
        .select({ id: t.users.id, email: t.users.email })
        .from(t.users)
        .innerJoin(t.memberships, eq(t.memberships.userId, t.users.id))
        .where(eq(t.memberships.orgId, orgId)),
      this.db
        .select({ id: t.runbooks.id, name: t.runbooks.name })
        .from(t.runbooks)
        .where(eq(t.runbooks.orgId, orgId)),
    ]);
    if (!teams.length && !users.length) return `orgId: unknown organisation "${orgId}"`;
    const teamBySlug = new Map(teams.map((x) => [slug(x.name), x.id]));
    const userByEmail = new Map(users.map((x) => [x.email.toLowerCase(), x.id]));
    const runbookByName = new Map(runbooks.map((x) => [x.name, x.id]));
    return {
      orgId,
      team: (k) => teamBySlug.get(slug(k)),
      user: (e) => userByEmail.get(e.toLowerCase()),
      runbook: (n) => runbookByName.get(n),
    };
  }

  private async changed(orgId: string, id: string, version: number) {
    await this.redis.publish(
      CONFIG_CHANGED,
      JSON.stringify(ConfigChanged.parse({ kind: 'rules', orgId, id, version })),
    );
  }
}

/** Same rule apart from id / version (both normalised by the Rule schema). */
function sameRule(stored: unknown, next: Rule): boolean {
  const a = Rule.safeParse(stored);
  if (!a.success) return false;
  const strip = ({ id: _i, version: _v, ...r }: Rule) => JSON.stringify(r);
  return strip(a.data) === strip(next);
}

const issuesText = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues.map((i) => `${i.path.map(String).join('.') || '(file)'}: ${i.message}`).join('; ');

const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;

export interface RulesWatcherOptions {
  owner: string;
  leaseMs?: number;
  /** Full rescan while holding the lease (catches events the watcher missed). */
  rescanMs?: number;
  debounceMs?: number;
  log?: Logger;
}

/**
 * Runs `RulesSync` in one worker instance: the holder of `lease:rules-sync` watches the
 * directory (`fs.watch`, debounced per file) and rescans it now and then; the others retry the
 * lease every few seconds and take over if the holder stops renewing.
 */
export class RulesWatcher {
  private watcher?: FSWatcher;
  private holding = false;
  private timers: NodeJS.Timeout[] = [];
  private pending = new Map<string, NodeJS.Timeout>();
  private lastRescan = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sync: RulesSync,
    private readonly redis: Redis,
    private readonly dir: string,
    private readonly o: RulesWatcherOptions,
  ) {}

  get isHolder(): boolean {
    return this.holding;
  }

  start(): void {
    void this.tick();
    this.timers.push(setInterval(() => void this.tick(), Math.min(5000, (this.o.leaseMs ?? 15_000) / 3)));
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const t of this.pending.values()) clearTimeout(t);
    this.watcher?.close();
    await this.chain;
    if (this.holding) {
      await this.redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
        1,
        RULES_SYNC_LEASE,
        this.o.owner,
      );
    }
    this.holding = false;
  }

  /** Renew or take the lease; start / stop watching accordingly. */
  async tick(): Promise<void> {
    const ttl = this.o.leaseMs ?? 15_000;
    try {
      const held = this.holding
        ? (await this.redis.eval(RENEW, 1, RULES_SYNC_LEASE, this.o.owner, ttl)) === 1
        : (await this.redis.set(RULES_SYNC_LEASE, this.o.owner, 'PX', ttl, 'NX')) === 'OK';
      if (held && !this.holding) this.becomeHolder();
      else if (!held && this.holding) this.loseHold();
      if (held && Date.now() - this.lastRescan >= (this.o.rescanMs ?? 30_000))
        this.enqueue(() => this.rescan());
    } catch (err) {
      this.o.log?.warn({ err }, 'rules sync lease check failed');
    }
  }

  private becomeHolder() {
    this.holding = true;
    this.o.log?.info({ dir: this.dir }, 'rules sync: watching');
    try {
      this.watcher = watch(this.dir, (_event, name) => {
        if (name && RULE_FILE.test(name)) this.schedule(name.toString());
      });
      this.watcher.on('error', (err) => this.o.log?.warn({ err }, 'rules watcher error'));
    } catch (err) {
      this.o.log?.warn({ err, dir: this.dir }, 'rules directory not watchable, rescanning only');
    }
  }

  private loseHold() {
    this.holding = false;
    this.watcher?.close();
    this.watcher = undefined;
    this.o.log?.warn('rules sync lease lost');
  }

  private schedule(file: string) {
    clearTimeout(this.pending.get(file));
    this.pending.set(
      file,
      setTimeout(() => {
        this.pending.delete(file);
        if (this.holding) this.enqueue(() => this.sync.syncFile(file));
      }, this.o.debounceMs ?? 100),
    );
  }

  private async rescan() {
    this.lastRescan = Date.now();
    await this.sync.syncAll();
  }

  /** One sync at a time, in order. */
  private enqueue(job: () => Promise<unknown>) {
    this.chain = this.chain.then(job).catch((err) => this.o.log?.error({ err }, 'rules sync failed'));
  }
}
