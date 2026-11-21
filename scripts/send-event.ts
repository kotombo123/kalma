/**
 * POSTs a fixture to ingest. Usage: pnpm send-event <fixture> [sourceId|http|kafka|file|poll] [--count N]
 * e.g. pnpm send-event events/alertmanager-firing.json
 */
import { SEED, SEED_API_KEYS } from '@alerting/contracts';
import { readFixture } from '@alerting/contracts/fixtures';
import { env } from '@alerting/config';

const [fixture, sourceArg = 'http', ...rest] = process.argv.slice(2);
if (!fixture) {
  console.error('usage: pnpm send-event <fixture> [source] [--count N]');
  process.exit(1);
}
const count = Number(rest[rest.indexOf('--count') + 1]) || 1;
const alias = sourceArg as keyof typeof SEED.sources;
const sourceId = SEED.sources[alias] ?? sourceArg;
const key = SEED_API_KEYS[alias] ?? process.env.INGEST_API_KEY ?? '';

const contentType = fixture.endsWith('.json')
  ? 'application/json'
  : fixture.endsWith('.xml')
    ? 'application/xml'
    : fixture.endsWith('.csv')
      ? 'text/csv'
      : 'text/plain';
const body = readFixture(fixture);

for (let i = 0; i < count; i++) {
  const res = await fetch(`${env().INGEST_URL}/ingest/${sourceId}`, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-api-key': key },
    body,
  });
  console.log(res.status, await res.text());
}
