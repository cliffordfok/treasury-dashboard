import assert from 'node:assert/strict';
import {
  attachPricesToPositions,
  calculateStockMarketTotals,
  parseYahooQuoteResponse,
} from './stockPriceCalculations.js';
import {
  buildStockQuoteProxyErrorMessage,
  DEFAULT_STOCK_QUOTE_PROXY_URL,
  fetchStockQuotes,
  getStockQuoteProxyUrl,
  normalizeStockQuoteProxyResponse,
  resolveStockQuoteProxyUrl,
} from './stockQuoteClient.js';
import {
  filterQuotesForSave,
  getSymbolsNeedingRefresh,
  isQuoteStale,
  shouldAttemptAutoRefresh,
  shouldPreserveManualPrice,
} from './autoQuoteRefresh.js';
import stockQuoteApiHandler from '../../../api/stock-quotes.js';
import {
  handleStockQuoteRequest,
  normalizeStockSymbols,
  parseYahooQuotePayload,
} from '../../../workers/stock-quotes-worker.js';

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

const mockVercelResponse = () => {
  const response = {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(value = '') {
      this.body = value;
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    },
  };
  return response;
};

const makeYahooFetch = (payload, ok = true, status = 200) => async () => ({
  ok,
  status,
  json: async () => payload,
});

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

const workerMissingPrice = parseYahooQuotePayload(
  { quoteResponse: { result: [{ symbol: 'MU', currency: 'USD' }] } },
  ['MU'],
);
assert.equal(workerMissingPrice.quotes.length, 0, 'worker missing price creates no quote');
assert.equal(workerMissingPrice.errors[0].symbol, 'MU', 'worker missing price error symbol');

assert.deepEqual(normalizeStockSymbols(['voo', 'VOO', 'BRK.B']), ['VOO', 'BRK.B'], 'worker normalizes symbols');
assert.throws(() => normalizeStockSymbols(['bad symbol']), /Invalid symbol/, 'worker rejects invalid symbol');
assert.throws(() => normalizeStockSymbols(Array.from({ length: 26 }, (_, index) => `T${index}`)), /Maximum 25/, 'worker rejects too many symbols');

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
assert.equal(resolveStockQuoteProxyUrl({ VITE_AI_PROXY_URL: 'https://worker.example.com' }), 'https://worker.example.com', 'AI proxy fallback URL');
assert.equal(resolveStockQuoteProxyUrl({ VITE_STOCK_QUOTE_PROXY_URL: 'https://quotes.example.com', VITE_AI_PROXY_URL: 'https://worker.example.com' }), 'https://quotes.example.com', 'stock quote env takes priority');
await assert.rejects(() => fetchStockQuotes(['bad symbol'], { proxyUrl: '/api/stock-quotes', fetchImpl: async () => ({}) }), /Invalid stock symbol/, 'invalid symbol');

await assert.rejects(
  () => fetchStockQuotes(['VOO'], {
    fetchImpl: async (url) => {
      assert.equal(url, DEFAULT_STOCK_QUOTE_PROXY_URL, 'default fetch URL');
      return { ok: false, status: 404, text: async () => 'not found' };
    },
  }),
  (error) => error.message.includes('Proxy URL: /api/stock-quotes') && error.message.includes('HTTP 404'),
  '404 proxy unavailable error',
);

await assert.rejects(
  () => fetchStockQuotes(['VOO'], {
    fetchImpl: async () => {
      throw new Error('network failed');
    },
  }),
  (error) => error.message.includes('Proxy URL: /api/stock-quotes') && error.message.includes('network failed'),
  'network proxy unavailable error',
);

await assert.rejects(
  () => fetchStockQuotes(['VOO'], {
    proxyUrl: 'https://worker.example.com',
    fetchImpl: async () => ({ ok: false, status: 405, text: async () => 'method not allowed' }),
  }),
  (error) => error.message.includes('Proxy URL: https://worker.example.com') && error.message.includes('HTTP 405') && error.message.includes('GitHub Pages'),
  '405 proxy error includes URL and deployment guidance',
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

let apiRes = mockVercelResponse();
await stockQuoteApiHandler({ method: 'GET' }, apiRes);
assert.equal(apiRes.statusCode, 200, 'Vercel API GET health status');
assert.equal(apiRes.json().ok, true, 'Vercel API GET health body');
assert.equal(apiRes.headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS', 'Vercel API CORS methods');

apiRes = mockVercelResponse();
await stockQuoteApiHandler({ method: 'OPTIONS' }, apiRes);
assert.equal(apiRes.statusCode, 204, 'Vercel API OPTIONS status');

const originalFetch = globalThis.fetch;
globalThis.fetch = makeYahooFetch({
  quoteResponse: {
    result: [{ symbol: 'VOO', regularMarketPrice: 600, currency: 'USD', regularMarketTime: 1780593600 }],
  },
});
try {
  apiRes = mockVercelResponse();
  await stockQuoteApiHandler({ method: 'POST', body: { symbols: ['voo'] } }, apiRes);
  assert.equal(apiRes.statusCode, 200, 'Vercel API POST status');
  assert.equal(apiRes.json().quotes[0].symbol, 'VOO', 'Vercel API POST quote symbol');
} finally {
  globalThis.fetch = originalFetch;
}

apiRes = mockVercelResponse();
await stockQuoteApiHandler({ method: 'DELETE' }, apiRes);
assert.equal(apiRes.statusCode, 405, 'Vercel API invalid method status');

let workerResponse = await handleStockQuoteRequest(new Request('https://quotes.example.com', { method: 'GET' }));
assert.equal(workerResponse.status, 200, 'Worker GET status');
assert.equal((await workerResponse.json()).ok, true, 'Worker GET health body');

workerResponse = await handleStockQuoteRequest(new Request('https://quotes.example.com', { method: 'OPTIONS' }));
assert.equal(workerResponse.status, 204, 'Worker OPTIONS status');
assert.equal(workerResponse.headers.get('Access-Control-Allow-Origin'), '*', 'Worker CORS origin');

workerResponse = await handleStockQuoteRequest(
  new Request('https://quotes.example.com', {
    method: 'POST',
    body: JSON.stringify({ symbols: ['voo'] }),
    headers: { 'Content-Type': 'application/json' },
  }),
  makeYahooFetch({
    quoteResponse: {
      result: [{ symbol: 'VOO', regularMarketPrice: 602, currency: 'USD', regularMarketTime: 1780593600 }],
    },
  }),
);
assert.equal(workerResponse.status, 200, 'Worker POST status');
near((await workerResponse.json()).quotes[0].price, 602, 'Worker POST quote price');

workerResponse = await handleStockQuoteRequest(
  new Request('https://quotes.example.com', {
    method: 'POST',
    body: JSON.stringify({ symbols: ['bad symbol'] }),
    headers: { 'Content-Type': 'application/json' },
  }),
  makeYahooFetch({}),
);
assert.equal(workerResponse.status, 400, 'Worker invalid symbol status');

workerResponse = await handleStockQuoteRequest(
  new Request('https://quotes.example.com', {
    method: 'POST',
    body: JSON.stringify({ symbols: Array.from({ length: 26 }, (_, index) => `T${index}`) }),
    headers: { 'Content-Type': 'application/json' },
  }),
  makeYahooFetch({}),
);
assert.equal(workerResponse.status, 400, 'Worker too many symbols status');

workerResponse = await handleStockQuoteRequest(
  new Request('https://quotes.example.com', {
    method: 'POST',
    body: JSON.stringify({ symbols: ['MU'] }),
    headers: { 'Content-Type': 'application/json' },
  }),
  makeYahooFetch({ quoteResponse: { result: [{ symbol: 'MU', currency: 'USD' }] } }),
);
const workerMissingQuote = await workerResponse.json();
assert.equal(workerMissingQuote.quotes.length, 0, 'Worker missing price quote count');
assert.equal(workerMissingQuote.errors[0].symbol, 'MU', 'Worker missing price error symbol');

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
