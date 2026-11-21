import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client.ts';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/** Applies all migrations (used by `pnpm db:migrate` and integration tests). */
export const runMigrations = (db: Db) => migrate(db, { migrationsFolder: MIGRATIONS_DIR });
