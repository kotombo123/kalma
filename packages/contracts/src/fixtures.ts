/** Node-only helpers for fixtures. Import from `@alerting/contracts/fixtures`. */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export const fixturePath = (name: string): string => join(FIXTURES_DIR, name);
export const readFixture = (name: string): string => readFileSync(fixturePath(name), 'utf8');
export const readJsonFixture = <T = unknown>(name: string): T => JSON.parse(readFixture(name)) as T;
export const listFixtures = (dir: string): string[] => readdirSync(fixturePath(dir)).sort();
