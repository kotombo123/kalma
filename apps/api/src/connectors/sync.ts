/**
 * Connector files (config/connectors/*.yaml) → sources in Postgres + collector configs on disk.
 * Same shape as apps/worker/src/rules-sync.ts: one holder (Redis lease) watches the folder, a bad file
 * keeps the previous config running and records the error. See docs/connectors/implementation_plan.md.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONNECTORS_SYNC_LEASE, newId, type Logger, type Redis } from '@alerting/config';
import { ConnectorFile, ConnectorTemplate } from '@alerting/contracts';
import { and, eq, sql, t, type Db } from '@alerting/db';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { publishConfigChanged } from '../lib/config-changed.ts';
import { buildCollector, fill, portRange, resolveSettings, type CollectorPart } from './build.ts';

export const CONNECTORS_DIR = 'config/connectors';
export const TEMPLATES_DIR = 'config/connectors/templates';
const FILE = /^[a-z0-9][a-z0-9-]*\.ya?ml$/;

export interface ConnectorStatus {
  file: string;
  connector?: string;
  ok: boolean;
  error?: string;
  sourceId?: string;
  ports?: number[];
  updatedAt: string;
}

export interface LoadedTemplate {
  meta: ConnectorTemplate;
  collector: CollectorPart;
}

/** Nearest directory above `from` with pnpm-workspace.yaml (works from apps/api and /repo). */
export function repoRoot(from = process.cwd()): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    if (dirname(dir) === dir) return from;
  }
}

/** Every template folder with a valid template.yaml + collector.yaml. Broken ones are reported, not loaded. */
export async function loadTemplates(
  root: string,
): Promise<{ templates: Map<string, LoadedTemplate>; errors: string[] }> {
  const dir = join(root, TEMPLATES_DIR);
  const templates = new Map<string, LoadedTemplate>();
  const errors: string[] = [];
  const names = existsSync(dir) ? await readdir(dir, { withFileTypes: true }) : [];
  for (const d of names.filter((x) => x.isDirectory())) {
    try {
      const meta = ConnectorTemplate.parse({
        id: d.name,
        ...(parseYaml(await readFile(join(dir, d.name, 'template.yaml'), 'utf8')) as object),
      });
      const collector = parseYaml(
        await readFile(join(dir, d.name, 'collector.yaml'), 'utf8'),
      ) as CollectorPart;
      templates.set(d.name, { meta, collector });
    } catch (err) {
      errors.push(`${d.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { templates, errors };
}

export interface ConnectorSyncOptions {
  root?: string;
  outDir: string;
  ingestUrl: string;
  ports: string;
  allowedSources: string;
  owner?: string;
  leaseMs?: number;
  log?: Logger;
}

export class ConnectorSync {
  readonly root: string;
  readonly outDir: string;
  private readonly portOk: (p: number) => boolean;
  private readonly allowed: Set<string>;
  private readonly statuses = new Map<string, ConnectorStatus>();
  /** ports in use per connector file, to refuse two connectors on one port */
  private readonly portsByFile = new Map<string, number[]>();
  private watcher?: FSWatcher;
  private timers: NodeJS.Timeout[] = [];
  private pending = new Map<string, NodeJS.Timeout>();
  private chain: Promise<unknown> = Promise.resolve();
  private holding = false;
  private readonly owner: string;

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly o: ConnectorSyncOptions,
  ) {
    this.root = o.root ?? repoRoot();
    this.outDir = isAbsolute(o.outDir) ? o.outDir : join(this.root, o.outDir);
    this.portOk = portRange(o.ports);
    this.allowed = new Set(
      o.allowedSources
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    this.owner = o.owner ?? newId();
  }

  status(): ConnectorStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.file.localeCompare(b.file));
  }

  start(): void {
    void this.tick();
    this.timers.push(setInterval(() => void this.tick(), 5_000));
  }

  async stop(): Promise<void> {
    for (const x of this.timers) clearInterval(x);
    for (const x of this.pending.values()) clearTimeout(x);
    this.watcher?.close();
    await this.chain;
    if (this.holding) await this.redis.del(CONNECTORS_SYNC_LEASE);
  }

  /** Take or renew the lease; the holder watches the folder and rescans every 30 s. */
  private lastRescan = 0;
  async tick(): Promise<void> {
    const ttl = this.o.leaseMs ?? 15_000;
    try {
      const held = this.holding
        ? (await this.redis.eval(
            `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`,
            1,
            CONNECTORS_SYNC_LEASE,
            this.owner,
            ttl,
          )) === 1
        : (await this.redis.set(CONNECTORS_SYNC_LEASE, this.owner, 'PX', ttl, 'NX')) === 'OK';
      if (held && !this.holding) this.holding = true;
      // (re)try watching on every tick: the folder may appear after the API started
      if (held && !this.watcher) this.watch();
      if (!held && this.holding) {
        this.holding = false;
        this.watcher?.close();
        this.watcher = undefined;
      }
      if (held && Date.now() - this.lastRescan >= 30_000) this.enqueue(() => this.rescan());
    } catch (err) {
      this.o.log?.warn({ err }, 'connectors sync lease check failed');
    }
  }

  private watch() {
    const dir = join(this.root, CONNECTORS_DIR);
    if (!existsSync(dir)) return;
    this.o.log?.info({ dir, outDir: this.outDir }, 'connectors sync: watching');
    try {
      this.watcher = watch(dir, { recursive: true }, (_e, name) => {
        if (!name) return;
        const n = name.toString();
        // a template changed: every connector may depend on it
        if (n.startsWith('templates')) this.schedule('*');
        else if (FILE.test(n)) this.schedule(n);
      });
      this.watcher.on('error', (err) => this.o.log?.warn({ err }, 'connectors watcher error'));
    } catch (err) {
      this.o.log?.warn({ err, dir }, 'connectors folder not watchable, rescanning only');
    }
  }

  private schedule(file: string) {
    clearTimeout(this.pending.get(file));
    this.pending.set(
      file,
      setTimeout(() => {
        this.pending.delete(file);
        if (!this.holding) return;
        this.enqueue(() => (file === '*' ? this.rescan() : this.syncFile(file)));
      }, 150),
    );
  }

  private enqueue(job: () => Promise<unknown>) {
    this.chain = this.chain.then(job).catch((err) => this.o.log?.error({ err }, 'connectors sync failed'));
  }

  /** All files on disk, plus file-managed sources whose file is gone. */
  async rescan(): Promise<void> {
    this.lastRescan = Date.now();
    const dir = join(this.root, CONNECTORS_DIR);
    const files = existsSync(dir) ? (await readdir(dir)).filter((f) => FILE.test(f)) : [];
    for (const f of files) await this.syncFile(f);
    const managed = await this.db
      .select({ filePath: t.sources.filePath })
      .from(t.sources)
      .where(and(eq(t.sources.origin, 'file'), eq(t.sources.enabled, true)));
    for (const m of managed) {
      const name = m.filePath?.split('/').pop();
      if (name && !files.includes(name)) await this.syncFile(name);
    }
  }

  private setStatus(file: string, s: Omit<ConnectorStatus, 'file' | 'updatedAt'>) {
    this.statuses.set(file, { file, ...s, updatedAt: new Date().toISOString() });
    if (!s.ok) this.o.log?.warn({ file, error: s.error }, 'connector file rejected');
  }

  /**
   * Everything that can be checked without writing: YAML, file format, template and settings, collector
   * limits, the system (in `orgId` when given) and port clashes with other files.
   */
  async prepare(
    text: string,
    file: string,
    orgId?: string,
  ): Promise<
    | { ok: true; c: ConnectorFile; part: CollectorPart; system: { id: string; orgId: string } }
    | { ok: false; error: string }
  > {
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (err) {
      return { ok: false, error: `YAML: ${err instanceof Error ? err.message : String(err)}` };
    }
    const parsed = ConnectorFile.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join('.') || 'plik'}: ${i.message}`).join('; '),
      };
    const c = parsed.data;

    // the collector part: from a template or the person's own
    let part: CollectorPart;
    if (c.template) {
      const { templates } = await loadTemplates(this.root);
      const tpl = templates.get(c.template);
      if (!tpl) return { ok: false, error: `template: nie ma szablonu "${c.template}" w ${TEMPLATES_DIR}/` };
      const s = resolveSettings(tpl.meta, c.settings, this.portOk);
      if (!s.ok) return s;
      part = fill(tpl.collector, s.values) as CollectorPart;
    } else part = c.collector!;
    const check = buildCollector(part, {
      connector: c.connector,
      allowedSources: this.allowed,
      portOk: this.portOk,
      ingestUrl: this.o.ingestUrl,
      sourceId: 'check',
      apiKey: 'check',
    });
    if (!check.ok) return check;
    for (const [other, ports] of this.portsByFile) {
      const clash = other !== file && ports.find((p) => check.ports.includes(p));
      if (clash) return { ok: false, error: `port ${clash} jest już zajęty przez ${other}` };
    }

    // the system decides the org: within `orgId` when known, else the one org with that system name
    const systems = await this.db
      .select({ id: t.systems.id, orgId: t.systems.orgId })
      .from(t.systems)
      .where(
        and(
          sql`lower(${t.systems.name}) = lower(${c.system})`,
          orgId ? eq(t.systems.orgId, orgId) : undefined,
        ),
      )
      .limit(2);
    if (systems.length === 0)
      return {
        ok: false,
        error: `system: nie ma systemu "${c.system}" (najpierw dodaj go w Połączonych systemach)`,
      };
    if (systems.length > 1)
      return {
        ok: false,
        error: `system: "${c.system}" jest w więcej niż jednej organizacji; zmień nazwę jednego z nich`,
      };
    return { ok: true, c, part, system: systems[0]! };
  }

  /**
   * A file dropped in the UI (admin of `orgId`): check it fully, then save it as
   * config/connectors/<connector>.yaml and sync it now. Nothing is written when the check fails.
   */
  async accept(text: string, orgId: string): Promise<ConnectorStatus> {
    const name = (() => {
      try {
        const v = (parseYaml(text) as { connector?: unknown } | null)?.connector;
        return typeof v === 'string' ? v : '';
      } catch {
        return '';
      }
    })();
    const file = `${/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) ? name : 'plik'}.yaml`;
    const now = () => new Date().toISOString();
    const [owner] = await this.db
      .select({ orgId: t.sources.orgId })
      .from(t.sources)
      .where(and(eq(t.sources.origin, 'file'), eq(t.sources.filePath, `${CONNECTORS_DIR}/${file}`)));
    if (owner && owner.orgId !== orgId)
      return { file, ok: false, error: 'connector: ta nazwa jest już zajęta', updatedAt: now() };
    const prep = await this.prepare(text, file, orgId);
    if (!prep.ok) return { file, ok: false, error: prep.error, updatedAt: now() };
    await mkdir(join(this.root, CONNECTORS_DIR), { recursive: true });
    await writeFile(join(this.root, CONNECTORS_DIR, file), text.endsWith('\n') ? text : `${text}\n`);
    await this.syncFile(file);
    return (
      this.statuses.get(file) ?? { file, ok: false, error: 'nie udało się zsynchronizować', updatedAt: now() }
    );
  }

  /** One connector file: create / update / disable its source and its collector config. */
  async syncFile(file: string): Promise<void> {
    const filePath = `${CONNECTORS_DIR}/${file}`;
    const [existing] = await this.db
      .select({
        id: t.sources.id,
        orgId: t.sources.orgId,
        apiKeyHash: t.sources.apiKeyHash,
        enabled: t.sources.enabled,
      })
      .from(t.sources)
      .where(and(eq(t.sources.origin, 'file'), eq(t.sources.filePath, filePath)));

    const text = await readFile(join(this.root, filePath), 'utf8').catch(() => null);
    if (text === null) {
      // file removed: stop the collector part and invalidate the key
      this.statuses.delete(file);
      this.portsByFile.delete(file);
      await this.removeOutput(file);
      if (existing?.enabled) {
        await this.db
          .update(t.sources)
          .set({ enabled: false, apiKeyHash: sha256(randomToken()), fileError: null })
          .where(eq(t.sources.id, existing.id));
        await publishConfigChanged(this.redis, { kind: 'sources', orgId: existing.orgId, id: existing.id });
      }
      return;
    }

    const fail = async (error: string) => {
      this.setStatus(file, { ok: false, error, sourceId: existing?.id });
      if (existing)
        await this.db.update(t.sources).set({ fileError: error }).where(eq(t.sources.id, existing.id));
    };

    const prep = await this.prepare(text, file, existing?.orgId);
    if (!prep.ok) return fail(prep.error);
    const { c, part, system } = prep;
    const orgId = system.orgId;

    // the key: reuse the one already in the generated file if it still matches, else issue a new one
    const previousKey = await this.readKey(file);
    const keyOk = existing && previousKey && sha256(previousKey) === existing.apiKeyHash;
    const apiKey = keyOk ? previousKey : `ak_${randomToken()}`;
    const sourceId = existing?.id ?? newId();

    const built = buildCollector(part, {
      connector: c.connector,
      allowedSources: this.allowed,
      portOk: this.portOk,
      ingestUrl: this.o.ingestUrl,
      sourceId,
      apiKey,
    });
    if (!built.ok) return fail(built.error);

    const row = {
      name: c.name,
      systemId: system.id,
      enabled: c.enabled,
      fileError: null,
      ...(!keyOk && { apiKeyHash: sha256(apiKey), apiKeyPrefix: apiKey.slice(0, 12) }),
    };
    if (existing) await this.db.update(t.sources).set(row).where(eq(t.sources.id, existing.id));
    else
      await this.db.insert(t.sources).values({
        id: sourceId,
        orgId,
        transport: 'http',
        config: { transport: 'http' },
        format: 'auto',
        origin: 'file',
        filePath,
        apiKeyHash: sha256(apiKey),
        apiKeyPrefix: apiKey.slice(0, 12),
        ...row,
      });

    if (c.enabled) await this.writeOutput(file, built.config);
    else await this.removeOutput(file);
    this.portsByFile.set(file, c.enabled ? built.ports : []);
    this.setStatus(file, { ok: true, connector: c.connector, sourceId, ports: built.ports });
    await publishConfigChanged(this.redis, { kind: 'sources', orgId, id: sourceId });
    this.o.log?.info({ file, sourceId, ports: built.ports }, 'connector synced');
  }

  private outFile(file: string) {
    return join(this.outDir, file.replace(/\.ya?ml$/, '.json'));
  }

  private async readKey(file: string): Promise<string | null> {
    try {
      const cfg = JSON.parse(await readFile(this.outFile(file), 'utf8')) as {
        sinks?: Record<string, { request?: { headers?: Record<string, string> } }>;
      };
      return Object.values(cfg.sinks ?? {})[0]?.request?.headers?.['x-api-key'] ?? null;
    } catch {
      return null;
    }
  }

  /** Write atomically; only the collector reads it (it holds the source's API key). */
  private async writeOutput(file: string, config: Record<string, unknown>) {
    await mkdir(this.outDir, { recursive: true });
    const target = this.outFile(file);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  }

  private async removeOutput(file: string) {
    await rm(this.outFile(file), { force: true });
  }
}
