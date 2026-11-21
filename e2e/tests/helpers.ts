import { expect, type Page } from '@playwright/test';
import { SEED, SEED_API_KEYS } from '@alerting/contracts';

export const INGEST = process.env.E2E_INGEST_URL ?? 'http://localhost:3001';
export const API = process.env.E2E_API_URL ?? 'http://localhost:3000';

/** POSTs an event to the seeded HTTP source, like an external system would. */
export async function sendEvent(body: unknown) {
  const res = await fetch(`${INGEST}/ingest/${SEED.sources.http}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': SEED_API_KEYS.http },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
}

/** Logs in through the form (works in production mode too: no dev-only shortcuts). */
export async function login(page: Page, email: string, password = 'demo') {
  // The UI defaults to English; these tests assert the Polish copy, so pick Polish before the app loads.
  await page.addInitScript(() => localStorage.setItem('kalma_lang', 'pl'));
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Hasło', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.getByRole('heading', { name: 'Alerty' })).toBeVisible();
  await expect(page.getByText('Na żywo')).toBeVisible();
}

/** Bearer token for API checks in tests. */
export async function apiToken(email: string, password = 'demo') {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return ((await res.json()) as { accessToken: string }).accessToken;
}

export const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
