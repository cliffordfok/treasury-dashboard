import { expect } from '@playwright/test';
import { isValidCusip } from '../src/lib/securities.js';

export const FIRESTORE_EMULATOR = 'http://127.0.0.1:8080';
export const PROJECT_ID = 'demo-treasury-dashboard';

const pad = (value) => String(value).padStart(2, '0');

// Local calendar date offset from today, matching how the app picks "today".
export const isoDate = (offsetDays = 0) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const uniqueUid = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const CURVE_TENORS = [
  ['DGS1MO', 0.0833, 3.83], ['DGS3MO', 0.25, 3.89], ['DGS6MO', 0.5, 3.95], ['DGS1', 1, 4.11],
  ['DGS2', 2, 4.34], ['DGS3', 3, 4.42], ['DGS5', 5, 4.55], ['DGS7', 7, 4.66],
  ['DGS10', 10, 4.77], ['DGS20', 20, 5.25], ['DGS30', 30, 5.25],
];

export const makeCurve = (observationDate) => ({
  points: CURVE_TENORS.map(([id, years, value]) => ({ id, years, yield: value, date: observationDate })),
  observationDate,
  updatedAt: observationDate,
});

export const trackDialogs = (page) => {
  const messages = [];
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message());
    await dialog.accept();
  });
  return messages;
};

export const withCheckDigit = (base) => {
  for (let digit = 0; digit <= 9; digit += 1) if (isValidCusip(`${base}${digit}`)) return `${base}${digit}`;
  throw new Error(`no check digit for ${base}`);
};

export const KNOWN_NOTE = { cusip: withCheckDigit('91282CQA'), type: 't-note', term: '5-Year', issueDate: isoDate(-30), maturityDate: isoDate(1795), couponRate: 3.875 };
export const KNOWN_BILL = { cusip: withCheckDigit('912797SB'), type: 't-bill', term: '26-Week', issueDate: isoDate(-7), maturityDate: isoDate(175), couponRate: 0 };

// A feed large enough to pass the app's completeness check.
export const makeSecuritiesFeed = () => ({
  generatedAt: isoDate(0),
  securities: [
    KNOWN_NOTE,
    KNOWN_BILL,
    ...Array.from({ length: 120 }, (_, index) => ({
      cusip: withCheckDigit(`9128${String(index).padStart(4, '0')}`),
      type: ['t-bill', 't-note', 't-bond'][index % 3],
      term: '',
      issueDate: isoDate(-100),
      maturityDate: isoDate(400 + index),
      couponRate: index % 3 === 0 ? 0 : 4,
    })),
  ],
});

// `securitiesReady` lets a test hold back the CUSIP list to exercise slow loads.
export async function openApp(page, {
  curveDate = isoDate(-1),
  securities = makeSecuritiesFeed(),
  securitiesReady = Promise.resolve(),
} = {}) {
  await page.route('**/yield-curve.json*', (route) => route.fulfill({ json: makeCurve(curveDate) }));
  await page.route('**/treasury-securities.json*', async (route) => {
    await securitiesReady;
    await (securities ? route.fulfill({ json: securities }) : route.fulfill({ status: 404, body: 'not found' }));
  });
  await page.goto('./');
}

// Returns the Firebase UID, which the Auth emulator assigns separately from the Google subject.
export async function signIn(page, googleSubject) {
  await page.waitForFunction(() => typeof window.__signInForTests === 'function');
  const uid = await page.evaluate(
    (subject) => window.__signInForTests(subject).then((credential) => credential.user.uid),
    googleSubject,
  );
  await expect(page.getByRole('tab', { name: /債券分析/ })).toBeVisible();
  return uid;
}

export async function importTrades(page, trades) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTitle('匯入資料').click(),
  ]);
  await chooser.setFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(trades)),
  });
}

const documentUrl = (uid, tradeId) => (
  `${FIRESTORE_EMULATOR}/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}/trades/${tradeId}`
);

// Reads and writes the emulator directly, as another device or an admin would.
export async function readStoredTrade(uid, tradeId) {
  const response = await fetch(documentUrl(uid, tradeId), { headers: { Authorization: 'Bearer owner' } });
  if (!response.ok) throw new Error(`Firestore REST read failed: ${response.status}`);
  const { fields } = await response.json();
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Object.values(value)[0]]));
}

export async function patchStoredTrade(uid, tradeId, field, value) {
  const response = await fetch(`${documentUrl(uid, tradeId)}?updateMask.fieldPaths=${field}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { [field]: { stringValue: value } } }),
  });
  if (!response.ok) throw new Error(`Firestore REST write failed: ${response.status}`);
}

export const sampleTrades = () => [
  {
    id: 'bill-stale', cusip: '912797STALE', type: 't-bill', side: 'buy',
    tradeDate: isoDate(-270), maturityDate: isoDate(90), faceValue: 100000, cleanPrice: 98,
    couponRate: 0, commission: 0, couponFrequency: 0, currentMarketPrice: 98, status: 'active',
  },
  {
    id: 'note-fresh', cusip: '91282NOTE', type: 't-note', side: 'buy',
    tradeDate: isoDate(-200), maturityDate: isoDate(1600), faceValue: 50000, cleanPrice: 99.5,
    couponRate: 4.25, commission: 10, couponFrequency: 2, currentMarketPrice: 100.25,
    priceUpdatedAt: isoDate(-2), status: 'active',
  },
  {
    id: 'note-short', cusip: '91282SHORT', type: 't-note', side: 'sell',
    tradeDate: isoDate(-150), maturityDate: isoDate(500), faceValue: 20000, cleanPrice: 100.1,
    couponRate: 3.875, commission: 5, couponFrequency: 2, currentMarketPrice: 100.4,
    priceUpdatedAt: isoDate(-1), status: 'active',
  },
  {
    id: 'closed-ok', cusip: 'CLOSEDOK', type: 't-note', side: 'buy',
    tradeDate: isoDate(-400), maturityDate: isoDate(400), faceValue: 1000, cleanPrice: 99,
    couponRate: 4, commission: 0, couponFrequency: 2, currentMarketPrice: 101, status: 'closed',
    closeDate: isoDate(-30), closePrice: 101, closeCommission: 0,
  },
  {
    id: 'closed-missing-terms', cusip: 'BADCLOSE', type: 't-note', side: 'buy',
    tradeDate: isoDate(-400), maturityDate: isoDate(400), faceValue: 1000, cleanPrice: 99,
    couponRate: 4, commission: 0, couponFrequency: 2, currentMarketPrice: 101, status: 'closed',
  },
];

export async function setupLedger(page) {
  const dialogs = trackDialogs(page);
  await openApp(page);
  const uid = await signIn(page, uniqueUid());
  await importTrades(page, sampleTrades());
  await expect.poll(() => dialogs.at(-1)).toContain('匯入完成');
  return { dialogs, uid };
}

export const tradeRow = (page, cusip) => page.locator('.holdings-table tbody tr', { hasText: cusip });

export async function updateMarketPrice(row, price) {
  await row.locator('td[data-label="市場淨價"] button').click();
  await row.getByLabel('新市場價格').fill(String(price));
  await row.getByRole('button', { name: '儲存' }).click();
}
