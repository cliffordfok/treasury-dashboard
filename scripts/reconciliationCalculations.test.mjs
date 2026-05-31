import assert from 'node:assert/strict';
import { buildReconciliationReport } from '../src/features/reconciliation/reconciliationCalculations.js';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);
const equal = (actual, expected, message) => assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);

const stockTrade = (overrides) => ({
  symbol: 'VOO',
  side: 'buy',
  tradeDate: '2026-05-01',
  quantity: 0,
  price: 0,
  commission: 0,
  fees: 0,
  currency: 'USD',
  createdAt: overrides.createdAt || overrides.tradeDate || '2026-05-01',
  ...overrides,
});

const cashMovement = (overrides) => ({
  type: 'opening_balance',
  date: '2026-05-01',
  amount: 0,
  currency: 'USD',
  ...overrides,
});

let report = buildReconciliationReport({
  snapshot: { brokerCashBalance: 13513.02, holdings: [] },
  cashMovements: [cashMovement({ amount: 13513.02 })],
  stockTrades: [],
});
near(report.cashComparison.difference, 0, 'case A cash difference');
equal(report.cashComparison.status, 'OK', 'case A cash status');

report = buildReconciliationReport({
  snapshot: { brokerCashBalance: 13512.52, holdings: [] },
  cashMovements: [cashMovement({ amount: 13513.02 })],
  stockTrades: [],
});
near(report.cashComparison.difference, -0.5, 'case B cash difference');
equal(report.cashComparison.status, 'SMALL_DIFF', 'case B cash status');

report = buildReconciliationReport({
  snapshot: { brokerCashBalance: '', holdings: [] },
  cashMovements: [cashMovement({ amount: 13513.02 })],
  stockTrades: [],
});
equal(report.cashComparison.brokerCashBalance, null, 'case B2 broker cash awaits input');
equal(report.cashComparison.difference, null, 'case B2 cash difference awaits input');
equal(report.cashComparison.status, 'AWAITING_INPUT', 'case B2 cash status');
equal(report.summary.issueCount, 0, 'case B2 cash awaiting input is not an issue');

const vooQuantity = 297.83252;
const vooCost = 45821.3;
const vooSystemTrades = [stockTrade({ symbol: 'VOO', quantity: vooQuantity, price: vooCost / vooQuantity })];
report = buildReconciliationReport({
  snapshot: { brokerCashBalance: 0, holdings: [{ symbol: 'VOO', brokerQuantity: 297.83252, brokerCostBasis: 45821.3 }] },
  stockTrades: vooSystemTrades,
  cashMovements: [],
});
equal(report.holdingComparisons.find((item) => item.symbol === 'VOO').status, 'OK', 'case C holding status');

report = buildReconciliationReport({
  snapshot: { brokerCashBalance: 0, holdings: [{ symbol: 'VOO', brokerQuantity: 297.8325, brokerCostBasis: 45821.3 }] },
  stockTrades: vooSystemTrades,
  cashMovements: [],
});
equal(report.holdingComparisons.find((item) => item.symbol === 'VOO').status, 'QTY_DIFF', 'case D holding status');

report = buildReconciliationReport({
  snapshot: { brokerCashBalance: 0, holdings: [] },
  stockTrades: [stockTrade({ symbol: 'NVDA', quantity: 1, price: 100 })],
  cashMovements: [],
});
equal(report.holdingComparisons.find((item) => item.symbol === 'NVDA').status, 'MISSING_IN_BROKER', 'case E holding status');

report = buildReconciliationReport({
  snapshot: { brokerCashBalance: 0, holdings: [{ symbol: 'TSLA', brokerQuantity: 1, brokerCostBasis: 250 }] },
  stockTrades: [],
  cashMovements: [],
});
equal(report.holdingComparisons.find((item) => item.symbol === 'TSLA').status, 'MISSING_IN_SYSTEM', 'case F holding status');
