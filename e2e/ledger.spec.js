import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { calculateForwardDaysBetween, getTBillInvestmentYield } from '../src/lib/treasuryMath.js';
import { isoDate, setupLedger, tradeRow, updateMarketPrice } from './helpers.js';

test('imports a backup and rejects a closed trade without close terms', async ({ page }) => {
  const { dialogs } = await setupLedger(page);
  expect(dialogs).toContain('匯入完成：新增 4 筆交易，略過 1 筆。');
  await page.getByRole('tab', { name: /債券帳本/ }).click();
  await expect(page.getByRole('tab', { name: /活躍 \(3\)/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /已結算 \(1\)/ })).toBeVisible();
});

test('flags a stale price and records the quote date when it changes', async ({ page }) => {
  await setupLedger(page);
  const banner = page.getByRole('status').filter({ hasText: '自訂市場價超過' });
  await expect(banner).toContainText('有 1 筆持倉');
  await banner.getByRole('button', { name: '前往帳本更新' }).click();

  const bill = tradeRow(page, '912797STALE');
  await expect(bill).toContainText(`報價日 ${isoDate(-270)}（270 日前）`);
  await bill.getByRole('button', { name: '採用為市場價' }).click();
  await expect(bill).toContainText(`報價日 ${isoDate(-1)}`);
  await expect(banner).toBeHidden();

  await updateMarketPrice(bill, 99.1);
  await expect(bill.locator('td[data-label="市場淨價"]')).toContainText('99.100');
  await expect(bill).toContainText(`報價日 ${isoDate(0)}`);
});

test('keeps an unchanged T-Bill quote at its purchase yield', async ({ page }) => {
  await setupLedger(page);
  const purchaseYield = getTBillInvestmentYield(98, calculateForwardDaysBetween(isoDate(-270), isoDate(90)), isoDate(-270));
  const row = page.locator('.maturity-row', { hasText: '912797STALE' });
  await expect(row.locator('.maturity-yield').first()).toContainText(`${purchaseYield.toFixed(2)}%`);
});

test('stops a closed trade from being edited into inconsistent dates', async ({ page }) => {
  const { dialogs } = await setupLedger(page);
  await page.getByRole('tab', { name: /債券帳本/ }).click();
  await page.getByRole('tab', { name: /已結算/ }).click();
  await tradeRow(page, 'CLOSEDOK').getByRole('button', { name: '編輯交易' }).click();
  await page.locator('#trade-maturity-date').fill(isoDate(-60));
  await page.getByRole('button', { name: '儲存交易' }).click();
  await expect.poll(() => dialogs.at(-1)).toContain('平倉交收日');
});

test('exports every stored trade', async ({ page }) => {
  await setupLedger(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('匯出資料').click(),
  ]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported.map((trade) => trade.id).sort()).toEqual(['bill-stale', 'closed-ok', 'note-fresh', 'note-short']);
});

test('lists nearby positions in the yield-curve tooltip', async ({ page }) => {
  await setupLedger(page);
  const dot = page.locator('.yield-chart .recharts-reference-dot circle').first();
  await dot.hover();
  const tooltip = page.locator('.yield-tooltip');
  await expect(tooltip).toContainText('曲線收益率');
  await expect(tooltip).toContainText('912797STALE');
});
