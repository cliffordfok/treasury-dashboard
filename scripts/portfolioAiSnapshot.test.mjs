import assert from 'node:assert/strict';
import { buildPortfolioAiMessages } from '../src/features/ai/portfolioAiPrompts.js';
import { buildCashAiSnapshot, buildPortfolioAiSnapshot, buildStockAiSnapshot, STOCK_QUOTES_DISABLED_LIMITATION } from '../src/features/ai/portfolioAiSnapshot.js';

const equal = (actual, expected, message) => assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

const stockTrades = [
  { symbol: 'voo', side: 'opening_position', tradeDate: '2026-05-01', quantity: 10, price: 450, commission: 0, fees: 0 },
  { symbol: 'VOO', side: 'buy', tradeDate: '2026-05-02', quantity: 2, price: 500, commission: 1, fees: 0 },
  { symbol: 'VOO', side: 'sell', tradeDate: '2026-05-03', quantity: 1, price: 520, commission: 1, fees: 0 },
  { symbol: 'NVDA', side: 'buy', tradeDate: '2026-05-04', quantity: 3, price: 100, commission: 0, fees: 0 },
];

const stockSnapshot = buildStockAiSnapshot(stockTrades);
equal(stockSnapshot.holdingCount, 2, 'stock snapshot holding count');
assert.deepEqual(stockSnapshot.symbols, ['NVDA', 'VOO'], 'stock snapshot symbols');
near(stockSnapshot.totals.stockTradeCashImpact, -782, 'stock trade cash impact');
equal(stockSnapshot.largestPositionsByRemainingCost[0].symbol, 'VOO', 'largest position by cost');
assert.equal(stockSnapshot.missingDataWarnings[0], STOCK_QUOTES_DISABLED_LIMITATION, 'stock quote limitation warning');

const singleStockSnapshot = buildStockAiSnapshot(stockTrades, null, { symbol: 'voo' });
equal(singleStockSnapshot.selectedSymbol, 'VOO', 'single stock selected symbol');
assert.deepEqual(singleStockSnapshot.symbols, ['VOO'], 'single stock mode only includes selected symbol');
equal(singleStockSnapshot.positions.length, 1, 'single stock one position');

const cashMovements = [
  { type: 'opening_balance', date: '2026-05-01', amount: 10000 },
  { type: 'deposit', date: '2026-05-02', amount: 500 },
  { type: 'withdrawal', date: '2026-05-03', amount: 200 },
  { type: 'dividend', date: '2026-05-04', grossAmount: 100, withholdingTax: 30, symbol: 'VOO' },
  { type: 'interest', date: '2026-05-05', amount: 12.5 },
  { type: 'fee', date: '2026-05-06', amount: 2 },
  { type: 'withholding_tax', date: '2026-05-07', amount: 5 },
];
const cashSnapshot = buildCashAiSnapshot(cashMovements);
near(cashSnapshot.cashMovementsTotal, 10375.5, 'cash movement total');
near(cashSnapshot.dividends, 70, 'dividend net received');
near(cashSnapshot.withholdingTax, 35, 'withholding tax');
near(cashSnapshot.fees, 2, 'fees');
equal(cashSnapshot.movementCount, 7, 'cash movement count');

const portfolioSnapshot = buildPortfolioAiSnapshot({
  mode: 'total_assets',
  stockTrades,
  cashMovements,
  reconciliationSnapshots: [
    {
      id: 'snapshot-1',
      date: '2026-05-31',
      brokerCashBalance: 9593.5,
      holdings: [
        { symbol: 'VOO', brokerQuantity: 10, brokerCostBasis: 4500 },
        { symbol: 'NVDA', brokerQuantity: 3, brokerCostBasis: 300 },
      ],
    },
  ],
  treasuryData: { trades: [{ cusip: '91282C', status: 'active', type: 't-note', side: 'buy', maturityDate: '2030-05-31', faceValue: 1000, cleanPrice: 99, couponRate: 4 }] },
  treasurySummary: { totalFullMarketValue: 990, totalMarketValue: 990, totalUnrealizedPnL: 0, totalFace: 1000, totalWeightYTM: 4, monthlyAvgIncome: 3.33 },
  asOf: '2026-06-07T00:00:00.000Z',
});
equal('marketValue' in portfolioSnapshot.stocks.totals, false, 'total assets snapshot does not use quote market value');
equal('stockUnrealizedPnl' in portfolioSnapshot.totals, false, 'total assets snapshot does not include stock unrealized pnl');
assert.equal(portfolioSnapshot.dataLimitations[0], STOCK_QUOTES_DISABLED_LIMITATION, 'portfolio data limitation includes missing quotes');
equal(portfolioSnapshot.reconciliation.latestSnapshotDate, '2026-05-31', 'reconciliation latest date');

const singlePortfolioSnapshot = buildPortfolioAiSnapshot({ mode: 'stock_single', selectedSymbol: 'NVDA', stockTrades, asOf: '2026-06-07T00:00:00.000Z' });
assert.deepEqual(singlePortfolioSnapshot.stocks.symbols, ['NVDA'], 'portfolio single stock mode only includes selected symbol');

const messages = buildPortfolioAiMessages({ snapshot: portfolioSnapshot, mode: 'stock_portfolio' });
const fullPrompt = messages.map((message) => message.content).join('\n');
assert.match(fullPrompt, /不要提供買入、賣出/, 'prompt contains no buy sell advice limit');
assert.match(fullPrompt, /不要提供目標價/, 'prompt contains no target price limit');
assert.match(fullPrompt, /不要預測股價/, 'prompt contains no stock prediction limit');
assert.match(fullPrompt, /不要引用 snapshot 以外的市場資料/, 'prompt contains no external data limit');
assert.match(fullPrompt, /目前股票報價功能已停用/, 'prompt contains quote disabled limitation');
assert.match(fullPrompt, /1\. 數據摘要/, 'prompt contains fixed output format');
