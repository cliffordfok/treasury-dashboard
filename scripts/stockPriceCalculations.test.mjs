import assert from 'node:assert/strict';
import { attachPricesToPositions, calculateStockMarketTotals, parseTwelveDataQuoteResponse } from '../src/features/prices/stockPriceCalculations.js';
import { buildTwelveDataQuoteUrl, fetchStockQuotes, normalizeQuoteSymbols } from '../src/features/prices/stockQuoteClient.js';

const equal = (actual, expected, message) => assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

assert.deepEqual(normalizeQuoteSymbols(['voo', 'VOO', 'nvda']), ['VOO', 'NVDA'], 'symbols normalize and dedupe');
assert.throws(() => normalizeQuoteSymbols(['bad symbol']), /股票代號格式不正確/, 'invalid symbols rejected');

const quoteUrl = buildTwelveDataQuoteUrl(['VOO', 'NVDA'], 'test-key');
assert.match(quoteUrl, /^https:\/\/api\.twelvedata\.com\/quote\?/, 'Twelve Data URL uses quote endpoint');
assert.match(quoteUrl, /symbol=VOO%2CNVDA/, 'Twelve Data URL includes symbols');
assert.match(quoteUrl, /apikey=test-key/, 'Twelve Data URL includes key');

let parsed = parseTwelveDataQuoteResponse(
  {
    symbol: 'VOO',
    close: '678.12',
    currency: 'USD',
    datetime: '2026-06-05',
    previous_close: '670.00',
    change: '8.12',
    percent_change: '1.21',
  },
  ['VOO'],
);
equal(parsed.provider, 'twelve_data', 'provider');
equal(parsed.quotes.length, 1, 'single quote parsed');
near(parsed.quotes[0].price, 678.12, 'single quote price');
near(parsed.quotes[0].previousClose, 670, 'single quote previous close');

parsed = parseTwelveDataQuoteResponse(
  {
    VOO: { symbol: 'VOO', close: '678.12', currency: 'USD', datetime: '2026-06-05' },
    NVDA: { symbol: 'NVDA', status: 'error', message: 'Invalid API call' },
  },
  ['VOO', 'NVDA', 'MU'],
);
equal(parsed.quotes.length, 1, 'multi quote parsed');
equal(parsed.errors.length, 2, 'multi quote errors include provider and missing symbol');
equal(parsed.errors[0].symbol, 'NVDA', 'provider error symbol');
equal(parsed.errors[1].symbol, 'MU', 'missing symbol error');

const positions = [
  { symbol: 'VOO', quantity: 2, remainingCost: 1000, averageCost: 500, realizedPnl: 0, currency: 'USD' },
  { symbol: 'MU', quantity: 1, remainingCost: 90, averageCost: 90, realizedPnl: 0, currency: 'USD' },
];
const withPrices = attachPricesToPositions(positions, {
  VOO: { symbol: 'VOO', price: 550, currency: 'USD', asOf: '2026-06-05T00:00:00.000Z', source: 'twelve_data' },
}, new Date('2026-06-06T00:00:00.000Z'));
near(withPrices[0].marketValue, 1100, 'market value');
near(withPrices[0].unrealizedPnl, 100, 'unrealized pnl');
equal(withPrices[1].currentPrice, null, 'missing price remains null');

const totals = calculateStockMarketTotals(withPrices);
near(totals.totalMarketValue, 1100, 'total market value');
near(totals.totalUnrealizedPnl, 100, 'total unrealized pnl');
equal(totals.pricedSymbolCount, 1, 'priced count');
equal(totals.missingPriceCount, 1, 'missing count');

const result = await fetchStockQuotes(['voo'], {
  apiKey: 'test-key',
  endpoint: 'https://example.test/quote',
  fetchImpl: async (url, options) => {
    assert.match(url, /symbol=VOO/, 'fetch URL includes normalized symbol');
    assert.match(url, /apikey=test-key/, 'fetch URL includes API key');
    equal(options.method, 'GET', 'fetch uses GET');
    return {
      ok: true,
      json: async () => ({ symbol: 'VOO', close: '600', currency: 'USD', datetime: '2026-06-05' }),
    };
  },
});
equal(result.quotes.length, 1, 'fetch normalizes response');
near(result.quotes[0].price, 600, 'fetch quote price');
