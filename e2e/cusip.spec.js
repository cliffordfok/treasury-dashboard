import { expect, test } from '@playwright/test';
import { KNOWN_BILL, KNOWN_NOTE, openApp, signIn, tradeRow, uniqueUid, withCheckDigit } from './helpers.js';

const openNewTradeForm = async (page) => {
  await page.getByRole('tab', { name: /債券帳本/ }).click();
  await page.getByRole('button', { name: /新增交易/ }).click();
};

test('fills the trade form from a known CUSIP and saves it', async ({ page }) => {
  await openApp(page);
  await signIn(page, uniqueUid());
  await openNewTradeForm(page);

  await page.locator('#trade-cusip').fill(KNOWN_NOTE.cusip.toLowerCase());
  await expect(page.locator('#trade-type')).toHaveValue('t-note');
  await expect(page.locator('#trade-maturity-date')).toHaveValue(KNOWN_NOTE.maturityDate);
  await expect(page.locator('#trade-coupon-rate')).toHaveValue('3.875');
  await expect(page.locator('.cusip-hint')).toContainText('已按財政部資料');

  await page.locator('#trade-clean-price').fill('99.5');
  await page.getByRole('button', { name: '儲存交易' }).click();
  await expect(tradeRow(page, KNOWN_NOTE.cusip)).toContainText(`到期：${KNOWN_NOTE.maturityDate}`);
});

test('offers to restore official terms after they are edited', async ({ page }) => {
  await openApp(page);
  await signIn(page, uniqueUid());
  await openNewTradeForm(page);
  await page.locator('#trade-cusip').fill(KNOWN_NOTE.cusip);
  await page.locator('#trade-coupon-rate').fill('5');
  const hint = page.locator('.cusip-hint');
  await expect(hint).toContainText('財政部資料');
  await hint.getByRole('button', { name: '帶入條款' }).click();
  await expect(page.locator('#trade-coupon-rate')).toHaveValue('3.875');
  await expect(hint).toContainText('已按財政部資料');
});

test('explains unknown and mistyped CUSIPs', async ({ page }) => {
  await openApp(page);
  await signIn(page, uniqueUid());
  await openNewTradeForm(page);
  const hint = page.locator('.cusip-hint');

  await page.locator('#trade-cusip').fill(withCheckDigit('912810ZZ'));
  await expect(hint).toContainText('找不到此 CUSIP');
  const wrongDigit = `${KNOWN_NOTE.cusip.slice(0, 8)}${(Number(KNOWN_NOTE.cusip[8]) + 1) % 10}`;
  await page.locator('#trade-cusip').fill(wrongDigit);
  await expect(hint).toContainText('檢查碼不正確');
});

test('falls back to manual entry when the securities list is unavailable', async ({ page }) => {
  await openApp(page, { securities: null });
  await signIn(page, uniqueUid());
  await openNewTradeForm(page);
  await page.locator('#trade-cusip').fill(KNOWN_NOTE.cusip);
  await expect(page.locator('.cusip-hint')).toContainText('暫時未能載入');
  await expect(page.locator('#trade-maturity-date')).toHaveValue('');
});

test('fills the YTM calculator and adds the bond to the ledger under its CUSIP', async ({ page }) => {
  await openApp(page);
  await signIn(page, uniqueUid());
  await page.getByRole('tab', { name: /到期收益率試算/ }).click();
  await page.locator('#ytm-cusip').fill(KNOWN_BILL.cusip);
  await expect(page.locator('#ytm-type')).toHaveValue('t-bill');
  await expect(page.locator('#ytm-maturity-date')).toHaveValue(KNOWN_BILL.maturityDate);
  await page.locator('#ytm-clean-price').fill('98.1');
  await page.getByRole('button', { name: /加入債券帳本/ }).click();
  await expect(tradeRow(page, KNOWN_BILL.cusip)).toContainText(`到期：${KNOWN_BILL.maturityDate}`);
});
