import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  attachPricesToPositions,
  calculateStockMarketTotals,
  parseYahooQuoteResponse,
} from './stockPriceCalculations.js';
import {
  buildStockQuoteCacheRequestUrl,
  fetchStockQuoteCache,
  isQuoteCacheStale,
  normalizeQuoteCacheSymbols,
  normalizeStockQuoteCache,
  STOCK_QUOTE_CACHE_SOURCE,
} from './stockQuoteCacheClient.js';
import {
  filterQuotesForSave,
  getSymbolsNeedingRefresh,
  isQuoteStale,
  shouldAttemptAutoRefresh,
  shouldPreserveManualPrice,
} from './autoQuoteRefresh.js';
import {
  buildQuoteCachePayload,
  discoverFirestoreQuoteSymbols,
  getUserIdFromStockTradePath,
  loadCombinedQuoteSymbols,
  normalizeYahooFinance2Quote,
  parseFirebaseServiceAccount,
  updateStockQuoteCache,
  validateQuoteSymbols,
} from '../../../scripts/update-stock-quotes.mjs';

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

assert.deepEqual(validateQuoteSymbols(['voo', 'VOO', 'BRK.B']).symbols, ['VOO', 'BRK.B'], 'script normalizes symbols');
assert.equal(validateQuoteSymbols(['bad symbol']).errors[0].symbol, 'BAD SYMBOL', 'script flags invalid symbol');
assert.equal(validateQuoteSymbols(Array.from({ length: 51 }, (_, index) => `T${index}`)).symbols.length, 50, 'script limits symbols');
assert.equal(parseFirebaseServiceAccount('{"project_id":"demo"}').project_id, 'demo', 'service account JSON parse');
assert.equal(parseFirebaseServiceAccount(Buffer.from('{"project_id":"demo64"}').toString('base64')).project_id, 'demo64', 'service account base64 parse');
assert.equal(parseFirebaseServiceAccount(''), null, 'blank service account is optional');
assert.equal(getUserIdFromStockTradePath({ path: 'users/u1/stockTrades/t1' }), 'u1', 'extract user id from stock trade path');
assert.deepEqual(normalizeQuoteCacheSymbols(['voo', 'VOO', 'BRK-B']), ['VOO', 'BRK-B'], 'client normalizes symbols');
assert.throws(() => normalizeQuoteCacheSymbols(['bad symbol']), /Invalid stock symbol/, 'client rejects invalid symbol');
assert.equal(
  buildStockQuoteCacheRequestUrl('/stock-quotes/latest.json', 'abc123'),
  '/stock-quotes/latest.json?_ts=abc123',
  'cache request URL adds cache buster',
);
assert.equal(
  buildStockQuoteCacheRequestUrl('/stock-quotes/latest.json?x=1', 'abc123'),
  '/stock-quotes/latest.json?x=1&_ts=abc123',
  'cache request URL preserves existing query',
);
assert.equal(
  buildStockQuoteCacheRequestUrl('/stock-quotes/latest.json', false),
  '/stock-quotes/latest.json',
  'cache request URL can disable cache buster',
);

const normalizedYahoo2 = normalizeYahooFinance2Quote({
  symbol: 'mu',
  regularMarketPrice: 95.5,
  currency: 'usd',
  regularMarketTime: new Date('2026-06-05T20:00:00.000Z'),
  regularMarketPreviousClose: 94,
  regularMarketChange: 1.5,
  regularMarketChangePercent: 1.59,
});
assert.equal(normalizedYahoo2.symbol, 'MU', 'script quote symbol');
assert.equal(normalizedYahoo2.source, STOCK_QUOTE_CACHE_SOURCE, 'script quote source');
near(normalizedYahoo2.price, 95.5, 'script quote price');
assert.equal(normalizeYahooFinance2Quote({ symbol: 'MU' }), null, 'missing price is not converted to zero');

const tempQuoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quote-cache-test-'));
const tempSymbolsPath = path.join(tempQuoteDir, 'symbols.json');
const tempLatestPath = path.join(tempQuoteDir, 'latest.json');
await fs.writeFile(tempSymbolsPath, JSON.stringify({ symbols: ['voo', 'missing'] }), 'utf8');
const fakeDb = {
  collectionGroup: (name) => {
    assert.equal(name, 'stockTrades', 'Firestore discovery uses stockTrades collection group');
    return {
      get: async () => ({
        docs: [
          { ref: { path: 'users/u1/stockTrades/1' }, data: () => ({ symbol: 'GLDM', side: 'buy', tradeDate: '2026-06-01', quantity: 39, price: 84.8 }) },
          { ref: { path: 'users/u1/stockTrades/2' }, data: () => ({ symbol: 'CLOSED', side: 'buy', tradeDate: '2026-06-01', quantity: 1, price: 10 }) },
          { ref: { path: 'users/u1/stockTrades/3' }, data: () => ({ symbol: 'CLOSED', side: 'sell', tradeDate: '2026-06-02', quantity: 1, price: 10 }) },
          { ref: { path: 'users/u2/stockTrades/1' }, data: () => ({ symbol: 'TSLA', side: 'opening_position', tradeDate: '2026-06-01', quantity: 2, price: 200 }) },
        ],
      }),
    };
  },
};
const discovered = await discoverFirestoreQuoteSymbols(fakeDb);
assert.deepEqual(discovered.symbols, ['GLDM', 'TSLA'], 'Firestore discovery returns positive holding symbols');
const combinedSymbols = await loadCombinedQuoteSymbols({ inputPath: tempSymbolsPath, db: fakeDb });
assert.deepEqual(combinedSymbols.symbols, ['VOO', 'MISSING', 'GLDM', 'TSLA'], 'configured and discovered symbols merge');
const generatedCache = await updateStockQuoteCache({
  inputPath: tempSymbolsPath,
  outputPath: tempLatestPath,
  db: fakeDb,
  now: new Date('2026-06-06T12:00:00.000Z'),
  quoteClient: {
    quote: async (symbol) => {
      if (symbol === 'MISSING') throw new Error('mock missing quote');
      return {
        symbol,
        regularMarketPrice: 601.25,
        currency: 'USD',
        regularMarketTime: new Date('2026-06-06T11:00:00.000Z'),
      };
    },
  },
});
assert.equal(generatedCache.quotes[0].symbol, 'VOO', 'updater writes quote from quote client instance');
assert.equal(generatedCache.errors[0].symbol, 'MISSING', 'updater keeps per-symbol error');
assert.equal(generatedCache.symbolSources.discoveredCount, 2, 'updater records Firestore discovery count');
const generatedCacheFile = JSON.parse(await fs.readFile(tempLatestPath, 'utf8'));
near(generatedCacheFile.quotes[0].price, 601.25, 'updater writes latest.json');

const cachePayload = buildQuoteCachePayload({
  updatedAt: '2026-06-05T20:00:00.000Z',
  quotes: [
    { symbol: 'voo', price: 600, currency: 'usd', asOf: '2026-06-05T20:00:00.000Z' },
    { symbol: 'OLD', price: 10, currency: 'USD', asOf: '2026-06-05T20:00:00.000Z' },
    { symbol: 'BAD', currency: 'USD' },
  ],
  errors: [{ symbol: 'ERR', error: 'No quote returned' }],
});

const cache = normalizeStockQuoteCache(cachePayload, ['VOO', 'NVDA', 'BAD'], {
  now: new Date('2026-06-06T01:00:00.000Z'),
  staleHours: 24,
});
assert.equal(cache.provider, 'yahoo_finance2', 'cache provider');
assert.equal(cache.quotes.length, 1, 'cache only includes matching valid quote');
assert.equal(cache.quotes[0].symbol, 'VOO', 'cache quote symbol');
assert.equal(cache.quotes[0].source, STOCK_QUOTE_CACHE_SOURCE, 'cache quote source');
assert.equal(
  cache.errors.find((error) => error.symbol === 'NVDA').error,
  '報價快取未包含此股票；如剛新增持倉，請先執行 Update Stock Quotes workflow；如仍缺少，請確認 workflow 已設定 Firestore symbol discovery 或手動加入 symbols.json',
  'missing cache symbol',
);
assert.equal(cache.errors.find((error) => error.symbol === 'BAD').error, 'Invalid cached quote price', 'invalid cached price');
assert.equal(cache.isStale, false, 'fresh cache');

const staleCache = normalizeStockQuoteCache(cachePayload, ['VOO'], {
  now: new Date('2026-06-07T01:00:00.000Z'),
  staleHours: 24,
});
assert.equal(staleCache.isStale, true, 'stale cache warning');
assert.equal(staleCache.warnings[0], '報價快取可能已過期', 'stale cache warning text');
assert.equal(isQuoteCacheStale(null), true, 'missing cache date is stale');

const fetchedCache = await fetchStockQuoteCache(['voo'], {
  cacheUrl: '/stock-quotes/latest.json',
  cacheBust: 'test-run',
  fetchImpl: async (url, options) => {
    assert.equal(url, '/stock-quotes/latest.json?_ts=test-run', 'cache fetch URL');
    assert.equal(options.cache, 'no-store', 'cache fetch disables browser cache');
    return {
      ok: true,
      json: async () => cachePayload,
    };
  },
  now: new Date('2026-06-05T21:00:00.000Z'),
});
near(fetchedCache.quotes[0].price, 600, 'fetch cache quote');

await assert.rejects(
  () => fetchStockQuoteCache(['VOO'], {
    cacheUrl: '/stock-quotes/latest.json',
    fetchImpl: async () => ({ ok: false, status: 404 }),
  }),
  /Unable to load stock quote cache.*HTTP 404/,
  'cache fetch HTTP error',
);

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
const olderYahoo = { symbol: 'VOO', source: STOCK_QUOTE_CACHE_SOURCE, asOf: '2026-06-05T11:00:00.000Z' };
assert.equal(shouldPreserveManualPrice(manualExisting, olderYahoo, 'auto'), true, 'auto preserves newer manual price');
assert.equal(shouldPreserveManualPrice(manualExisting, olderYahoo, 'manual'), false, 'manual refresh can overwrite manual price');
assert.deepEqual(filterQuotesForSave([olderYahoo], { VOO: manualExisting }, 'auto'), [], 'auto filters quote behind manual price');
assert.deepEqual(filterQuotesForSave([olderYahoo], { VOO: manualExisting }, 'manual').map((quote) => quote.symbol), ['VOO'], 'manual refresh keeps quote');
