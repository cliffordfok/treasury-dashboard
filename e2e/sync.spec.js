import { expect, test } from '@playwright/test';
import {
  FIRESTORE_EMULATOR,
  patchStoredTrade,
  readStoredTrade,
  setupLedger,
  tradeRow,
  updateMarketPrice,
} from './helpers.js';

const hasFirestoreCache = (page) => page.evaluate(async () => (
  (await indexedDB.databases()).some((database) => database.name?.startsWith('firestore/'))
));

test('opens the ledger from the device cache when Firestore is unreachable', async ({ page }) => {
  await setupLedger(page);
  await page.getByRole('tab', { name: /債券帳本/ }).click();
  await expect(page.locator('.holdings-table tbody tr')).toHaveCount(3);

  await page.route(`${FIRESTORE_EMULATOR}/**`, (route) => route.abort());
  await page.reload();
  await page.getByRole('tab', { name: /債券帳本/ }).click();
  await expect(page.locator('.holdings-table tbody tr')).toHaveCount(3);
});

test('queues an offline edit and syncs it after reconnecting', async ({ page }) => {
  const { uid } = await setupLedger(page);
  await page.getByRole('tab', { name: /債券帳本/ }).click();
  await page.context().setOffline(true);
  const offlineBanner = page.getByRole('status').filter({ hasText: '離線模式' });
  await expect(offlineBanner).toBeVisible();

  const note = tradeRow(page, '91282NOTE');
  await updateMarketPrice(note, 101.5);
  // Applied locally straight away instead of waiting for the server.
  await expect(note.locator('td[data-label="市場淨價"]')).toContainText('101.500');
  await expect(offlineBanner).toContainText('1 項待同步');

  await page.context().setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: /離線模式|正在同步/ })).toHaveCount(0);
  await expect.poll(async () => (await readStoredTrade(uid, 'note-fresh')).currentMarketPrice, { timeout: 30_000 })
    .toBe(101.5);
});

test('keeps a field changed on another device when this device saves a price', async ({ page }) => {
  const { uid } = await setupLedger(page);
  await page.getByRole('tab', { name: /債券帳本/ }).click();
  const note = tradeRow(page, '91282NOTE');
  await expect(note).toBeVisible();

  // While this page is offline it cannot see the other device's change, so its
  // queued write is based on the old document.
  await page.context().setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: '離線模式' })).toBeVisible();
  await patchStoredTrade(uid, 'note-fresh', 'cusip', 'OTHER-DEVICE');
  await updateMarketPrice(note, 101.25);
  await page.context().setOffline(false);

  await expect.poll(() => readStoredTrade(uid, 'note-fresh'), { timeout: 60_000 })
    .toMatchObject({ currentMarketPrice: 101.25, cusip: 'OTHER-DEVICE' });
});

test('clears the cached ledger from the device on sign-out', async ({ page }) => {
  await setupLedger(page);
  await expect.poll(() => hasFirestoreCache(page)).toBe(true);
  // Signing out clears the cache and then reloads the page.
  const reloaded = page.waitForEvent('load');
  await page.getByTitle('登出').click();
  await reloaded;
  await expect(page.getByText('使用 Google 帳號登入')).toBeVisible();
  await expect.poll(() => hasFirestoreCache(page)).toBe(false);
});
