import { expect, test } from '@playwright/test';
import { readJsonFixture } from '@alerting/contracts/fixtures';
import { API, apiToken, login, sendEvent, unique } from './helpers.ts';

/** E2E-1/2 in the UI: an event becomes a live alert → acknowledge → comment → resolve. */
test('alert lifecycle: event → live feed → acknowledge → resolve', async ({ page }) => {
  await login(page, 'admin@acme.test');

  const workflowId = `WF-E2E-${unique()}`;
  const event = { ...readJsonFixture<Record<string, unknown>>('events/workflow-failed.json'), workflowId };
  await sendEvent(event);

  // the alert arrives in the open feed without a reload (WebSocket)
  const token = await apiToken('admin@acme.test');
  let alertId = '';
  await expect
    .poll(async () => {
      const res = await fetch(`${API}/alerts?status=open&limit=50`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const list = (
        (await res.json()) as { data: { id: string; lastEvent: { raw: { workflowId?: string } } }[] }
      ).data;
      alertId = list.find((a) => a.lastEvent.raw.workflowId === workflowId)?.id ?? '';
      return alertId;
    })
    .not.toBe('');
  const row = page.locator('tbody tr', { has: page.locator(`a[href="/alerts/${alertId}"]`) });
  await expect(row).toBeVisible();
  await expect(row.getByText('Otwarty')).toBeVisible();

  // acknowledge from the feed: the row updates in place
  await row.getByRole('button', { name: 'Potwierdź' }).click();
  await expect(row.getByText('Potwierdzony')).toBeVisible();

  // detail: runbook steps of the settlement rule, comment, resolve
  await row.getByRole('link').click();
  await expect(page.getByRole('heading', { name: 'Co zrobić' })).toBeVisible();
  await page.getByPlaceholder('Dodaj komentarz dla zespołu').fill('Sprawdzam counterparty-service');
  await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
  await expect(page.getByText('Sprawdzam counterparty-service')).toBeVisible();
  await page.getByRole('button', { name: 'Rozwiąż' }).click();
  await expect(page.getByText(/rozwiązany/i).first()).toBeVisible();
  await expect(page.getByText(/Admin rozwiązuje/)).toBeVisible();
});
