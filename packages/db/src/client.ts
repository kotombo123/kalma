import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@alerting/config';
import * as schema from './schema.ts';

export type Db = PostgresJsDatabase<typeof schema>;

export function createDb(url = env().DATABASE_URL, max = 10): { db: Db; sql: postgres.Sql } {
  const sql = postgres(url, { max, onnotice: () => {} });
  return { db: drizzle(sql, { schema }), sql };
}
