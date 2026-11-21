import { createHash, timingSafeEqual } from 'node:crypto';
import type { ParserOptions, Source } from '@alerting/contracts';
import { eq, t, type Db } from '@alerting/db';

/** What ingest needs to know about a source. */
export interface IngestSource {
  id: string;
  orgId: string;
  transport: Source['transport'];
  format: Source['format'];
  parserOptions?: ParserOptions;
  apiKeyHash: string;
  enabled: boolean;
}

export type LoadSource = (id: string) => Promise<IngestSource | undefined>;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Constant-time check of a presented API key against the stored sha256 hex. */
export function keyMatches(key: string, apiKeyHash: string): boolean {
  const a = Buffer.from(sha256(key), 'hex');
  const b = Buffer.from(apiKeyHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function dbSourceLoader(db: Db): LoadSource {
  return async (id) => {
    const [row] = await db
      .select({
        id: t.sources.id,
        orgId: t.sources.orgId,
        transport: t.sources.transport,
        format: t.sources.format,
        parserOptions: t.sources.parserOptions,
        apiKeyHash: t.sources.apiKeyHash,
        enabled: t.sources.enabled,
      })
      .from(t.sources)
      .where(eq(t.sources.id, id))
      .limit(1);
    if (!row) return undefined;
    return { ...row, format: row.format as Source['format'], parserOptions: row.parserOptions ?? undefined };
  };
}

export interface SourceCacheOptions {
  /** Found sources are re-read after this long even without `config:changed`. */
  ttlMs?: number;
  /** Unknown ids are remembered this long, so a bad client cannot hammer the DB. */
  missTtlMs?: number;
  maxEntries?: number;
}

/**
 * Source lookups with a TTL cache. Concurrent misses for one id share one DB query.
 * `invalidate()` is called on `config:changed` (kind `sources`).
 */
export class SourceCache {
  private entries = new Map<string, { value: IngestSource | undefined; expires: number }>();
  private inflight = new Map<string, Promise<IngestSource | undefined>>();
  private readonly ttlMs: number;
  private readonly missTtlMs: number;
  private readonly maxEntries: number;

  constructor(
    private readonly load: LoadSource,
    opts: SourceCacheOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.missTtlMs = opts.missTtlMs ?? 5_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  async get(id: string): Promise<IngestSource | undefined> {
    const hit = this.entries.get(id);
    if (hit && hit.expires > Date.now()) return hit.value;

    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.load(id).finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    const value = await pending;
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(id, { value, expires: Date.now() + (value ? this.ttlMs : this.missTtlMs) });
    return value;
  }

  /** Drop one source, or everything when no id is given. */
  invalidate(id?: string): void {
    if (id) this.entries.delete(id);
    else this.entries.clear();
  }
}
