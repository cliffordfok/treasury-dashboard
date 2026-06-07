import assert from 'node:assert/strict';
import { buildBookValueAssetAllocation, buildPortfolioOverview } from '../src/features/portfolio/portfolioCalculations.js';

const equal = (actual, expected, message) => assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

let overview = buildPortfolioOverview();
const removedSnapshotKey = ['recon', 'ciliation'].join('');
equal(overview.stocks.symbolCount, 0, 'empty overview stock symbols');
equal(overview.cash.calculatedCashBalance, 0, 'empty overview cash balance');
equal(removedSnapshotKey in overview, false, 'overview only exposes active modules');
equal('marketValue' in overview.stocks, false, 'stock market value is disabled');
equal('unrealizedPnl' in overview.stocks, false, 'stock unrealized pnl is disabled');
equal(overview.assetAllocation.isEmpty, true, 'empty overview allocation empty state');

overview = buildPortfolioOverview({
  stockTrades: [
    { symbol: 'VOO', side: 'buy', tradeDate: '2026-05-01', quantity: 2, price: 680, commission: 0, fees: 0 },
    { symbol: 'NVDA', side: 'buy', tradeDate: '2026-05-02', quantity: 1, price: 100, commission: 0, fees: 0 },
  ],
});
equal(overview.stocks.symbolCount, 2, 'stock summary symbol count');
near(overview.stocks.remainingCost, 1460, 'stock summary remaining cost');
near(overview.stocks.cashImpact, -1460, 'stock summary cash impact');

overview = buildPortfolioOverview({
  stockTrades: [
    { symbol: 'VOO', side: 'buy', tradeDate: '2026-05-01', quantity: 2, price: 680, commission: 0, fees: 0 },
  ],
  stockPrices: [
    { symbol: 'VOO', price: 700, currency: 'USD', asOf: new Date().toISOString(), source: 'manual' },
  ],
});
near(overview.stocks.remainingCost, 1360, 'portfolio overview uses remaining cost instead of stock quotes');
equal('marketValue' in overview.stocks, false, 'portfolio overview does not use stock quote market value');

overview = buildPortfolioOverview({
  cashMovements: [{ type: 'opening_balance', date: '2026-05-01', amount: 10000 }],
});
near(overview.cash.cashMovementsTotal, 10000, 'cash movement total');
near(overview.cash.calculatedCashBalance, 10000, 'cash calculated balance');

overview = buildPortfolioOverview({
  stockTrades: [{ symbol: 'VOO', side: 'buy', tradeDate: '2026-05-01', quantity: 2, price: 680, commission: 0, fees: 0 }],
  cashMovements: [{ type: 'opening_balance', date: '2026-05-01', amount: 10000 }],
});
equal(removedSnapshotKey in overview, false, 'removed snapshot input is ignored');

let allocation = buildBookValueAssetAllocation({
  cashBalance: 100,
  stockRemainingCost: 300,
  treasuryPrincipal: 600,
});
equal(allocation.rows.length, 3, 'allocation includes cash stocks treasuries');
near(allocation.rows.find((row) => row.key === 'cash').percent, 10, 'cash allocation percent');
near(allocation.rows.find((row) => row.key === 'stocks').percent, 30, 'stocks allocation percent');
near(allocation.rows.find((row) => row.key === 'treasuries').percent, 60, 'treasuries allocation percent');
near(allocation.rows.reduce((total, row) => total + row.percent, 0), 100, 'allocation percent total');

allocation = buildBookValueAssetAllocation({
  cashBalance: -50,
  stockRemainingCost: 0,
  treasuryPrincipal: 200,
});
equal(allocation.rows.length, 1, 'allocation excludes non-positive rows');
equal(allocation.rows[0].key, 'treasuries', 'only positive treasury row remains');
equal(allocation.warnings[0], '現金為負數，未納入圓形圖比例。', 'negative cash warning');

allocation = buildBookValueAssetAllocation({
  cashBalance: 0,
  stockRemainingCost: 0,
  treasuryPrincipal: 0,
});
equal(allocation.isEmpty, true, 'zero total allocation empty state');
equal(allocation.rows.length, 0, 'zero total allocation has no rows');

overview = buildPortfolioOverview({
  treasuryMetrics: { totalFace: 600, totalMarketValue: 999999, totalFullMarketValue: 999999 },
  stockTrades: [{ symbol: 'VOO', side: 'buy', tradeDate: '2026-05-01', quantity: 3, price: 100, commission: 0, fees: 0 }],
  cashMovements: [{ type: 'opening_balance', date: '2026-05-01', amount: 400 }],
  stockPrices: [{ symbol: 'VOO', price: 1000 }],
});
near(overview.assetAllocation.rows.find((row) => row.key === 'cash').percent, 10, 'overview allocation cash percent');
near(overview.assetAllocation.rows.find((row) => row.key === 'stocks').amount, 300, 'overview allocation uses stock remaining cost');
near(overview.assetAllocation.rows.find((row) => row.key === 'treasuries').amount, 600, 'overview allocation uses treasury principal');
equal('marketValue' in overview.assetAllocation.rows.find((row) => row.key === 'stocks'), false, 'allocation does not depend on stock market value');
