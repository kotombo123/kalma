import { newId, uiChannel, type Logger, type Redis } from '@alerting/config';
import { UiEvent, type SchemaInfo } from '@alerting/contracts';
import { and, eq, sql, t, type Db } from '@alerting/db';
import { describeFields, detectPreset, guessRoles } from '@alerting/schema';
import type { ResolvedSchema, SchemaPort } from './ports.ts';

const CACHE_TTL_MS = 60_000;

/**
 * Schemas by (org, fingerprint), cached. A new fingerprint is inserted with status `new`
 * (ON CONFLICT DO NOTHING, so racing workers agree) and announced as `schema.discovered`.
 * Events of an unmapped schema use a detected preset's mapping, else guessed roles.
 */
export class DbSchemas implements SchemaPort {
  private cache = new Map<string, { value: ResolvedSchema; expires: number }>();
  private counts = new Map<string, { events: number; unmatched: number }>();

  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly log?: Logger,
  ) {}

  async resolve(input: Parameters<SchemaPort['resolve']>[0]): Promise<ResolvedSchema> {
    const key = `${input.orgId}:${input.fingerprint}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    let row = await this.find(input.orgId, input.fingerprint);
    if (!row) {
      const info: SchemaInfo = {
        id: newId(),
        orgId: input.orgId,
        fingerprint: input.fingerprint,
        sourceId: input.sourceId,
        status: 'new',
        fields: describeFields(input.flat),
        sample: input.raw,
        guessedRoles: guessRoles(input.flat),
        eventCount: 0,
        unmatchedCount: 0,
      };
      const inserted = await this.db
        .insert(t.schemas)
        .values({
          id: info.id,
          orgId: info.orgId,
          sourceId: info.sourceId,
          fingerprint: info.fingerprint,
          status: 'new',
          fields: info.fields,
          sample: info.sample,
          guessedRoles: info.guessedRoles,
        })
        .onConflictDoNothing()
        .returning({ id: t.schemas.id });
      if (inserted.length) {
        this.log?.info({ schemaId: info.id, sourceId: info.sourceId }, 'new schema');
        await this.redis.publish(
          uiChannel(info.orgId),
          JSON.stringify(UiEvent.parse({ type: 'schema.discovered', schema: info })),
        );
      }
      row = (await this.find(input.orgId, input.fingerprint))!;
    }

    const value: ResolvedSchema = {
      schemaId: row.id,
      status: row.status,
      mapping: row.mapping ?? detectPreset(input.flat)?.mapping,
    };
    this.cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  }

  private async find(orgId: string, fingerprint: string) {
    const [row] = await this.db
      .select({
        id: t.schemas.id,
        status: t.schemas.status,
        roles: t.mappings.roles,
        severityMap: t.mappings.severityMap,
        resolvedValues: t.mappings.resolvedValues,
      })
      .from(t.schemas)
      .leftJoin(t.mappings, eq(t.mappings.id, t.schemas.mappingId))
      .where(and(eq(t.schemas.orgId, orgId), eq(t.schemas.fingerprint, fingerprint)))
      .limit(1);
    if (!row) return undefined;
    return {
      id: row.id,
      status: row.status,
      mapping: row.roles
        ? {
            roles: row.roles,
            severityMap: row.severityMap ?? undefined,
            resolvedValues: row.resolvedValues ?? undefined,
          }
        : undefined,
    };
  }

  count(schemaId: string, unmatched: boolean): void {
    const c = this.counts.get(schemaId) ?? { events: 0, unmatched: 0 };
    c.events++;
    if (unmatched) c.unmatched++;
    this.counts.set(schemaId, c);
  }

  /** Writes accumulated counters (called every second). */
  async flush(): Promise<void> {
    if (this.counts.size === 0) return;
    const batch = [...this.counts];
    this.counts.clear();
    for (const [id, c] of batch) {
      await this.db
        .update(t.schemas)
        .set({
          eventCount: sql`${t.schemas.eventCount} + ${c.events}`,
          unmatchedCount: sql`${t.schemas.unmatchedCount} + ${c.unmatched}`,
          lastSeen: sql`now()`,
        })
        .where(eq(t.schemas.id, id));
    }
  }

  /** `config:changed` for mappings / schemas: forget that schema (or all). */
  invalidate(schemaId?: string): void {
    if (!schemaId) return this.cache.clear();
    for (const [key, entry] of this.cache) if (entry.value.schemaId === schemaId) this.cache.delete(key);
  }
}
