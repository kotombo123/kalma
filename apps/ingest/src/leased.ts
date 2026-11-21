import { sourceLeaseKey, type Logger } from '@alerting/config';
import type { LeaseStore } from './lease.ts';

export interface Running {
  stop(): void;
}

export interface LeasedSourcesOptions<S> {
  kind: string;
  load: () => Promise<S[]>;
  leases: LeaseStore;
  /** Unique per ingest process: the lease owner token. */
  owner: string;
  start: (source: S) => Running;
  /** Config that, when changed, restarts the source. */
  keyOf: (source: S) => string;
  /** Sources failing this are skipped (with a warning) instead of started. */
  allowed?: (source: S) => boolean;
  leaseMs?: number;
  log?: Logger;
}

/**
 * Exactly one ingest instance runs each source: the one holding `lease:source:{id}`. `sync()`
 * (start, `config:changed`, every few seconds) renews held leases, takes free ones, and stops
 * sources that are gone, changed, or whose lease another instance took.
 */
export class LeasedSources<S extends { id: string }> {
  private running = new Map<string, { key: string; run: Running }>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly o: LeasedSourcesOptions<S>) {}

  get active(): string[] {
    return [...this.running.keys()];
  }

  sync(): Promise<void> {
    this.chain = this.chain
      .then(() => this.doSync())
      .catch((err) => this.o.log?.error({ err }, `${this.o.kind} sync failed`));
    return this.chain;
  }

  async stopAll(): Promise<void> {
    await this.chain;
    for (const id of [...this.running.keys()]) await this.drop(id);
  }

  private async drop(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.run.stop();
    this.running.delete(id);
    await this.o.leases.release(sourceLeaseKey(id), this.o.owner);
    this.o.log?.info({ sourceId: id }, `${this.o.kind} stopped`);
  }

  private async doSync(): Promise<void> {
    const ttl = this.o.leaseMs ?? 15_000;
    const wanted = new Map((await this.o.load()).map((s) => [s.id, s]));

    for (const [id, r] of this.running) {
      const s = wanted.get(id);
      if (!s || this.o.keyOf(s) !== r.key) {
        await this.drop(id);
      } else if (!(await this.o.leases.renew(sourceLeaseKey(id), this.o.owner, ttl))) {
        // Lost the lease (paused process, Redis failover): someone else runs it now.
        r.run.stop();
        this.running.delete(id);
        this.o.log?.warn({ sourceId: id }, `${this.o.kind} lease lost`);
      }
    }

    for (const [id, s] of wanted) {
      if (this.running.has(id) || (this.o.allowed && !this.o.allowed(s))) continue;
      if (!(await this.o.leases.acquire(sourceLeaseKey(id), this.o.owner, ttl))) continue;
      this.running.set(id, { key: this.o.keyOf(s), run: this.o.start(s) });
      this.o.log?.info({ sourceId: id }, `${this.o.kind} started`);
    }
  }
}
