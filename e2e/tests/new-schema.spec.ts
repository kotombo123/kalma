import { expect, test } from '@playwright/test';
import { login, sendEvent, unique } from './helpers.ts';

/** E2E-3: a message shape nobody has seen → mapped by clicks → rule from the mapping → alert. */
test('new schema → mapping → rule → alert', async ({ page }) => {
  const id = unique();
  // field names nobody else uses, so the fingerprint is new
  const field = `probe_${id}`;
  const event = {
    [field]: { reading: 'disk.pressure', lvl: 'CRIT', node: `db-${id}` },
    ts: new Date().toISOString(),
  };
  await sendEvent(event);

  await login(page, 'admin@acme.test');
  await page.getByRole('link', { name: 'Nowe rodzaje wiadomości' }).first().click();
  const tile = page.locator('li a', { hasText: field });
  await expect(tile).toBeVisible({ timeout: 15_000 });
  await tile.click();

  await expect(page.getByRole('heading', { name: 'Tak zobaczy to system' })).toBeVisible();
  await page.getByLabel('Co jest tytułem problemu?').selectOption(`${field}.reading`);
  await page.getByLabel('Jak poważny jest problem?').selectOption(`${field}.lvl`);
  await page.getByLabel('Czego dotyczy?').selectOption(`${field}.node`);
  const result = page.locator('section[aria-labelledby=result]');
  await expect(result.locator('dl').getByText('disk.pressure')).toBeVisible();
  await expect(result.locator('dl').getByText('Krytyczny')).toBeVisible();
  await page.getByLabel('Jak nazwać ten rodzaj wiadomości?').fill(`E2E ${id}`);
  await page.getByRole('button', { name: 'Zapisz i ustal, kto dostaje te alerty' }).click();

  await expect(page.getByRole('heading', { name: 'Nowa reguła' })).toBeVisible();
  await page.getByLabel('Zespół', { exact: true }).selectOption({ label: 'Settlements' });
  await expect(page.locator('section[aria-labelledby=summary]')).toContainText('zespołu Settlements');
  await page.getByRole('button', { name: 'Utwórz regułę' }).click();
  await expect(page.getByRole('heading', { name: 'Historia wersji' })).toBeVisible();

  // the next event of this shape becomes an alert, live in the feed
  await page.getByRole('link', { name: 'Alerty' }).first().click();
  await sendEvent({ ...event, ts: new Date().toISOString() });
  await expect(
    page.locator('tbody tr', { hasText: 'disk.pressure' }).filter({ hasText: 'Settlements' }).first(),
  ).toBeVisible({
    timeout: 15_000,
  });
});
