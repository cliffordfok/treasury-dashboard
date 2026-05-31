import assert from 'node:assert/strict';
import { calculatePortfolioCashSummary, getCashMovementImpact } from '../src/features/cash/cashCalculations.js';
import { getStockTradeCashImpact } from '../src/features/stocks/stockCalculations.js';

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

const cashMovement = (overrides) => ({
  type: 'deposit',
  date: '2026-05-01',
  amount: 0,
  currency: 'USD',
  ...overrides,
});

const stockTrade = (overrides) => ({
  symbol: 'VOO',
  side: 'buy',
  tradeDate: '2026-05-01',
  quantity: 0,
  price: 0,
  commission: 0,
  fees: 0,
  currency: 'USD',
  ...overrides,
});

const openingBalance = cashMovement({ type: 'opening_balance', amount: 10000 });
const vooBuy = stockTrade({ quantity: 2, price: 680 });
let summary = calculatePortfolioCashSummary([openingBalance], [vooBuy]);
near(getStockTradeCashImpact(vooBuy), -1360, 'case A stock trade cash impact');
near(summary.calculatedCashBalance, 8640, 'case A calculated cash balance');

const dividend = cashMovement({ type: 'dividend', symbol: 'VOO', amount: '', grossAmount: 100, withholdingTax: 30 });
summary = calculatePortfolioCashSummary([openingBalance, dividend], [vooBuy]);
near(getCashMovementImpact(dividend), 70, 'case B dividend cash impact');
near(summary.dividendNetReceived, 70, 'case B dividend net received');
near(summary.dividendWithholdingTax, 30, 'case B withholding tax');

const vooSell = stockTrade({ side: 'sell', quantity: 1, price: 700, commission: 1, fees: 0.05 });
near(getStockTradeCashImpact(vooSell), 698.95, 'case C stock trade cash impact');

const withdrawal = cashMovement({ type: 'withdrawal', amount: 500 });
near(getCashMovementImpact(withdrawal), -500, 'case D withdrawal cash impact');

const adjustment = cashMovement({ type: 'adjustment', amount: -2.18 });
near(getCashMovementImpact(adjustment), -2.18, 'case E adjustment cash impact');
