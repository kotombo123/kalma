import { createDb } from './client.ts';
import { runMigrations } from './migrations.ts';

const { db, sql } = createDb(undefined, 1);
await runMigrations(db);
await sql.end();
console.log('migrations applied');
