import assert from 'node:assert/strict';
import { calculateStockPositions, getStockTradeCashImpact } from '../src/features/stocks/stockCalculations.js';

const findPosition = (trades, symbol) => calculateStockPositions(trades).find((position) => position.symbol === symbol);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

const trade = (overrides) => ({
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

const caseA = [
  trade({ quantity: 2, price: 680, createdAt: '1' }),
];
let voo = findPosition(caseA, 'VOO');
near(voo.quantity, 2, 'case A shares');
near(voo.remainingCost, 1360, 'case A remainingCost');
near(voo.averageCost, 680, 'case A averageCost');
near(voo.realizedPnl, 0, 'case A realizedPnL');

const caseB = [
  ...caseA,
  trade({ quantity: 1, price: 650, tradeDate: '2026-05-02', createdAt: '2' }),
];
voo = findPosition(caseB, 'VOO');
near(voo.quantity, 3, 'case B shares');
near(voo.remainingCost, 2010, 'case B remainingCost');
near(voo.averageCost, 670, 'case B averageCost');
near(voo.realizedPnl, 0, 'case B realizedPnL');

const caseC = [
  ...caseB,
  trade({ side: 'sell', quantity: 1, price: 700, tradeDate: '2026-05-03', createdAt: '3' }),
];
voo = findPosition(caseC, 'VOO');
near(voo.quantity, 2, 'case C shares');
near(voo.remainingCost, 1340, 'case C remainingCost');
near(voo.realizedPnl, 30, 'case C realizedPnL');
near(getStockTradeCashImpact(caseC[2]), 700, 'case C cashImpact');

const caseD = [
  ...caseB,
  trade({ side: 'sell', quantity: 1, price: 700, commission: 1, fees: 0.05, tradeDate: '2026-05-03', createdAt: '3' }),
];
voo = findPosition(caseD, 'VOO');
near(voo.realizedPnl, 700 - 1 - 0.05 - 670, 'case D realizedPnL');
near(getStockTradeCashImpact(caseD[2]), 700 - 1 - 0.05, 'case D cashImpact');

const fractional = findPosition([trade({ symbol: 'NVDA', quantity: 0.123456, price: 100 })], 'NVDA');
near(fractional.quantity, 0.123456, 'fractional shares');
near(fractional.remainingCost, 12.3456, 'fractional remainingCost');

const openingOnly = [
  trade({ side: 'opening_position', quantity: 100, price: 450, createdAt: '1' }),
];
voo = findPosition(openingOnly, 'VOO');
near(voo.quantity, 100, 'opening_position shares');
near(voo.remainingCost, 45000, 'opening_position remainingCost');
near(voo.averageCost, 450, 'opening_position averageCost');
near(voo.realizedPnl, 0, 'opening_position realizedPnL');
near(voo.cashImpact, 0, 'opening_position position cashImpact');
near(getStockTradeCashImpact(openingOnly[0]), 0, 'opening_position trade cashImpact');

const openingThenBuy = [
  ...openingOnly,
  trade({ quantity: 10, price: 500, tradeDate: '2026-05-02', createdAt: '2' }),
];
voo = findPosition(openingThenBuy, 'VOO');
near(voo.quantity, 110, 'opening_position then buy shares');
near(voo.remainingCost, 50000, 'opening_position then buy remainingCost');
near(voo.averageCost, 50000 / 110, 'opening_position then buy averageCost');
near(voo.cashImpact, -5000, 'opening_position then buy cashImpact');

const openingThenSell = [
  ...openingOnly,
  trade({ side: 'sell', quantity: 10, price: 500, tradeDate: '2026-05-02', createdAt: '2' }),
];
voo = findPosition(openingThenSell, 'VOO');
near(voo.quantity, 90, 'opening_position then sell shares');
near(voo.remainingCost, 40500, 'opening_position then sell remainingCost');
near(voo.realizedPnl, 500, 'opening_position then sell realizedPnL');
near(voo.cashImpact, 5000, 'opening_position then sell cashImpact');

const negativeOpening = findPosition([
  trade({ side: 'opening_position', quantity: -1, price: 450 }),
], 'VOO');
assert.equal(negativeOpening, undefined, 'negative opening_position should not create a position');
