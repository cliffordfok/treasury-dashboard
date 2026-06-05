import assert from 'node:assert/strict';
import {
  attachPricesToPositions,
  calculateStockMarketTotals,
  parseYahooQuoteResponse,
} from './stockPriceCalculations.js';
import {
  DEFAULT_STOCK_QUOTE_PROXY_URL,
  fetchStockQuotes,
  getStockQuoteProxyUrl,
  normalizeStockQuoteProxyResponse,
  STOCK_QUOTE_PROXY_UNAVAILABLE_MESSAGE,
} from './stockQuoteClient.js';
import {
  filterQuotesForSave,
  getSymbolsNeedingRefresh,
  isQuoteStale,
  shouldAttemptAutoRefresh,
  shouldPreserveManualPrice,
} from './autoQuoteRefresh.js';

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

const yahoo = parseYahooQuoteResponse(
  {
    quoteResponse: {
      result: [
        {
          symbol: 'VOO',
          regularMarketPrice: 693.12,
          currency: 'USD',
          regularMarketTime: 1780593600,
          regularMarketPreviousClose: 690.25,
          regularMarketChange: 2.87,
          regularMarketChangePercent: 0.42,
        },
      ],
    },
  },
  ['VOO', 'MISSING'],
);

assert.equal(yahoo.provider, 'yahoo_finance_unofficial', 'Yahoo provider');
assert.equal(yahoo.quoteType, 'delayed_or_regular_market', 'Yahoo quote type');
assert.equal(yahoo.quotes.length, 1, 'Yahoo quote count');
assert.equal(yahoo.quotes[0].symbol, 'VOO', 'Yahoo symbol');
near(yahoo.quotes[0].price, 693.12, 'Yahoo price');
assert.equal(yahoo.errors[0].symbol, 'MISSING', 'missing symbol error');

const missingPrice = parseYahooQuoteResponse(
  { quoteResponse: { result: [{ symbol: 'XYZ', currency: 'USD' }] } },
  ['XYZ'],
);
assert.equal(missingPrice.quotes.length, 0, 'missing price creates no quote');
assert.equal(missingPrice.errors[0].symbol, 'XYZ', 'missing price error symbol');

const positions = [
  { symbol: 'VOO', quantity: 2, remainingCost: 1000, currency: 'USD' },
  { symbol: 'NVDA', quantity: 1, remainingCost: 100, currency: 'USD' },
];

const withPrices = attachPricesToPositions(
  positions,
  {
    VOO: { symbol: 'VOO', price: 600, asOf: '2026-06-04T20:00:00.000Z', source: 'manual' },
  },
  new Date('2026-06-05T00:00:00.000Z'),
);

near(withPrices[0].marketValue, 1200, 'market value');
near(withPrices[0].unrealizedPnl, 200, 'unrealized pnl');
near(withPrices[0].unrealizedPnlPercent, 20, 'unrealized pnl percent');
assert.equal(withPrices[0].isPriceStale, false, 'fresh price');
assert.equal(withPrices[1].marketValue, null, 'missing price market value');

const stale = attachPricesToPositions(
  [positions[0]],
  { VOO: { symbol: 'VOO', price: 600, asOf: '2026-05-30T20:00:00.000Z' } },
  new Date('2026-06-05T00:00:00.000Z'),
);
assert.equal(stale[0].isPriceStale, true, 'stale price');

const totals = calculateStockMarketTotals(withPrices);
near(totals.totalMarketValue, 1200, 'total market value');
near(totals.totalUnrealizedPnl, 200, 'total unrealized pnl');
assert.equal(totals.pricedSymbolCount, 1, 'priced count');
assert.equal(totals.missingPriceCount, 1, 'missing count');
assert.equal(totals.stalePriceCount, 0, 'stale count');

const proxyPayload = normalizeStockQuoteProxyResponse(
  {
    quotes: [{ symbol: 'voo', price: 600, currency: 'usd', asOf: '2026-06-04T20:00:00.000Z' }],
    errors: [{ symbol: 'BAD', error: 'No quote returned' }],
  },
  ['VOO', 'BAD', 'NVDA'],
);
assert.equal(proxyPayload.quotes[0].symbol, 'VOO', 'proxy normalizes symbol');
assert.equal(proxyPayload.errors.length, 2, 'proxy adds missing requested error');

assert.equal(getStockQuoteProxyUrl(), DEFAULT_STOCK_QUOTE_PROXY_URL, 'default proxy URL');
await assert.rejects(() => fetchStockQuotes(['bad symbol'], { proxyUrl: '/api/stock-quotes', fetchImpl: async () => ({}) }), /Invalid stock symbol/, 'invalid symbol');

await assert.rejects(
  () => fetchStockQuotes(['VOO'], {
    fetchImpl: async (url) => {
      assert.equal(url, DEFAULT_STOCK_QUOTE_PROXY_URL, 'default fetch URL');
      return { ok: false, status: 404, text: async () => 'not found' };
    },
  }),
  new RegExp(STOCK_QUOTE_PROXY_UNAVAILABLE_MESSAGE),
  '404 proxy unavailable error',
);

await assert.rejects(
  () => fetchStockQuotes(['VOO'], {
    fetchImpl: async () => {
      throw new Error('network failed');
    },
  }),
  new RegExp(STOCK_QUOTE_PROXY_UNAVAILABLE_MESSAGE),
  'network proxy unavailable error',
);

const fetched = await fetchStockQuotes(['voo'], {
  proxyUrl: '/api/stock-quotes',
  fetchImpl: async (url, options) => {
    assert.equal(url, '/api/stock-quotes', 'fetch URL');
    assert.equal(JSON.parse(options.body).symbols[0], 'VOO', 'fetch body symbols');
    return {
      ok: true,
      json: async () => ({
        quotes: [{ symbol: 'VOO', price: 601, currency: 'USD', asOf: '2026-06-04T20:00:00.000Z' }],
        errors: [],
      }),
    };
  },
});
near(fetched.quotes[0].price, 601, 'fetch proxy quote');

const q3Now = new Date('2026-06-05T12:00:00.000Z');
const q3Positions = [
  { symbol: 'VOO', quantity: 2 },
  { symbol: 'NVDA', quantity: 1 },
  { symbol: 'CASH', quantity: 0 },
  { symbol: 'BAD SYMBOL', quantity: 1 },
];
assert.deepEqual(
  getSymbolsNeedingRefresh(q3Positions, { VOO: { symbol: 'VOO', price: 600, asOf: '2026-06-05T08:00:00.000Z' } }, { now: q3Now, staleHours: 12 }),
  ['NVDA'],
  'missing quote needs refresh',
);
assert.deepEqual(
  getSymbolsNeedingRefresh(q3Positions, { VOO: { symbol: 'VOO', price: 600, asOf: '2026-06-05T08:00:00.000Z' }, NVDA: { symbol: 'NVDA', price: 120, asOf: '2026-06-05T08:00:00.000Z' } }, { now: q3Now, staleHours: 12 }),
  [],
  'fresh quotes do not need refresh',
);
assert.deepEqual(
  getSymbolsNeedingRefresh(q3Positions, { VOO: { symbol: 'VOO', price: 600, asOf: '2026-06-04T12:00:00.000Z' }, NVDA: { symbol: 'NVDA', price: 120, asOf: '2026-06-05T08:00:00.000Z' } }, { now: q3Now, staleHours: 12 }),
  ['VOO'],
  'stale quote needs refresh',
);
assert.equal(isQuoteStale({ symbol: 'VOO', asOf: '2026-06-05T01:00:00.000Z' }, 12, q3Now), false, 'quote inside stale window');
assert.equal(isQuoteStale({ symbol: 'VOO', asOf: '2026-06-04T23:00:00.000Z' }, 12, q3Now), true, 'quote outside stale window');
assert.equal(shouldAttemptAutoRefresh('2026-06-05T11:50:00.000Z', 15, q3Now), false, 'cooldown blocks auto refresh');
assert.equal(shouldAttemptAutoRefresh('2026-06-05T11:40:00.000Z', 15, q3Now), true, 'cooldown allows later auto refresh');
assert.equal(shouldAttemptAutoRefresh('2026-06-05T11:50:00.000Z', 15, q3Now, 'manual'), true, 'manual refresh ignores cooldown');

const manualExisting = { symbol: 'VOO', source: 'manual', asOf: '2026-06-05T12:00:00.000Z' };
const olderYahoo = { symbol: 'VOO', source: 'yahoo_finance_unofficial', asOf: '2026-06-05T11:00:00.000Z' };
assert.equal(shouldPreserveManualPrice(manualExisting, olderYahoo, 'auto'), true, 'auto preserves newer manual price');
assert.equal(shouldPreserveManualPrice(manualExisting, olderYahoo, 'manual'), false, 'manual refresh can overwrite manual price');
assert.deepEqual(filterQuotesForSave([olderYahoo], { VOO: manualExisting }, 'auto'), [], 'auto filters quote behind manual price');
assert.deepEqual(filterQuotesForSave([olderYahoo], { VOO: manualExisting }, 'manual').map((quote) => quote.symbol), ['VOO'], 'manual refresh keeps quote');
