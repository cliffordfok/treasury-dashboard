import assert from 'node:assert/strict';
import { buildPortfolioOverview } from '../src/features/portfolio/portfolioCalculations.js';

const equal = (actual, expected, message) => assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

let overview = buildPortfolioOverview();
equal(overview.stocks.symbolCount, 0, 'empty overview stock symbols');
equal(overview.cash.calculatedCashBalance, 0, 'empty overview cash balance');
equal(overview.reconciliation.hasSnapshot, false, 'empty overview reconciliation snapshot');
equal(overview.stocks.marketValueLabel, '暫未接報價', 'stock market value is not estimated');

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
  cashMovements: [{ type: 'opening_balance', date: '2026-05-01', amount: 10000 }],
});
near(overview.cash.cashMovementsTotal, 10000, 'cash movement total');
near(overview.cash.calculatedCashBalance, 10000, 'cash calculated balance');

overview = buildPortfolioOverview({
  stockTrades: [{ symbol: 'VOO', side: 'buy', tradeDate: '2026-05-01', quantity: 2, price: 680, commission: 0, fees: 0 }],
  cashMovements: [{ type: 'opening_balance', date: '2026-05-01', amount: 10000 }],
  reconciliationSnapshots: [
    { id: 'old', date: '2026-05-01', createdAt: '2026-05-01T00:00:00Z', brokerCashBalance: 9000, holdings: [] },
    { id: 'new', date: '2026-05-02', createdAt: '2026-05-02T00:00:00Z', brokerCashBalance: 8640, holdings: [{ symbol: 'VOO', brokerQuantity: 2, brokerCostBasis: 1360 }] },
  ],
});
equal(overview.reconciliation.hasSnapshot, true, 'reconciliation snapshot exists');
equal(overview.reconciliation.latestSnapshot.id, 'new', 'latest reconciliation snapshot selected');
near(overview.reconciliation.cashDifference, 0, 'latest reconciliation cash difference');
equal(overview.reconciliation.holdingsDifferenceCount, 0, 'latest reconciliation holdings differences');
