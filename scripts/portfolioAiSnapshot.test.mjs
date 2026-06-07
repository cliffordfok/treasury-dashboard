import assert from 'node:assert/strict';
import { AI_MODE_LABELS, buildPortfolioAiMessages } from '../src/features/ai/portfolioAiPrompts.js';
import { buildAiSnapshotSummary, detectForbiddenAdvice, isSingleStockModeReady, parseAiReportSections, sanitizeAiSnapshotForCopy } from '../src/features/ai/portfolioAiReport.js';
import { buildCashAiSnapshot, buildPortfolioAiSnapshot, buildStockAiSnapshot, STOCK_QUOTES_ANALYSIS_LIMITATION } from '../src/features/ai/portfolioAiSnapshot.js';

const equal = (actual, expected, message) => assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

const stockTrades = [
  { symbol: 'voo', side: 'opening_position', tradeDate: '2026-05-01', quantity: 10, price: 450, commission: 0, fees: 0 },
  { symbol: 'VOO', side: 'buy', tradeDate: '2026-05-02', quantity: 2, price: 500, commission: 1, fees: 0 },
  { symbol: 'VOO', side: 'sell', tradeDate: '2026-05-03', quantity: 1, price: 520, commission: 1, fees: 0 },
  { symbol: 'NVDA', side: 'buy', tradeDate: '2026-05-04', quantity: 3, price: 100, commission: 0, fees: 0 },
  { symbol: 'GLDM', side: 'buy', tradeDate: '2026-05-05', quantity: 2, price: 80, commission: 0, fees: 0 },
];

const stockPrices = [
  { symbol: 'VOO', price: 600, currency: 'USD', asOf: '2026-06-06T00:00:00.000Z', source: 'twelve_data' },
  { symbol: 'NVDA', price: 90, currency: 'USD', asOf: '2026-06-06T00:00:00.000Z', source: 'twelve_data' },
];

const stockSnapshot = buildStockAiSnapshot(stockTrades, null, { stockPrices });
equal(stockSnapshot.holdingCount, 3, 'stock snapshot holding count');
assert.deepEqual(stockSnapshot.symbols, ['GLDM', 'NVDA', 'VOO'], 'stock snapshot symbols');
near(stockSnapshot.totals.stockTradeCashImpact, -942, 'stock trade cash impact');
near(stockSnapshot.totals.marketValue, 6870, 'stock market value');
near(stockSnapshot.totals.unrealizedPnl, 1527.42, 'stock unrealized pnl');
equal(stockSnapshot.quoteSummary.pricedSymbolCount, 2, 'priced symbol count');
equal(stockSnapshot.quoteSummary.missingPriceCount, 1, 'missing price count');
equal(stockSnapshot.quoteSummary.quoteUsePolicy, STOCK_QUOTES_ANALYSIS_LIMITATION, 'quote use policy');
equal(stockSnapshot.largestPositionsByRemainingCost[0].symbol, 'VOO', 'largest position by cost');
equal(stockSnapshot.largestPositionsByMarketValue[0].symbol, 'VOO', 'largest position by market value');
assert.ok(stockSnapshot.riskSignals.some((signal) => signal.type === 'missing_quotes'), 'risk signals include missing quote');
assert.ok(stockSnapshot.riskSignals.some((signal) => signal.type === 'cost_concentration'), 'risk signals include concentration');
assert.ok(stockSnapshot.valuationObservations.some((row) => row.symbol === 'VOO' && row.observation.includes('現價高於剩餘成本')), 'valuation observation includes VOO');

const singleStockSnapshot = buildStockAiSnapshot(stockTrades, null, { symbol: 'voo', stockPrices });
equal(singleStockSnapshot.selectedSymbol, 'VOO', 'single stock selected symbol');
assert.deepEqual(singleStockSnapshot.symbols, ['VOO'], 'single stock mode only includes selected symbol');
equal(singleStockSnapshot.positions.length, 1, 'single stock one position');
near(singleStockSnapshot.positions[0].currentPrice, 600, 'single stock current price');
near(singleStockSnapshot.positions[0].marketValue, 6600, 'single stock market value');

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
  stockPrices,
  cashMovements,
  treasuryData: { trades: [{ cusip: '91282C', status: 'active', type: 't-note', side: 'buy', maturityDate: '2030-05-31', faceValue: 1000, cleanPrice: 99, couponRate: 4 }] },
  treasurySummary: { totalFullMarketValue: 990, totalMarketValue: 990, totalUnrealizedPnL: 0, totalFace: 1000, totalWeightYTM: 4, monthlyAvgIncome: 3.33 },
  asOf: '2026-06-07T00:00:00.000Z',
});
const removedSnapshotKey = ['recon', 'ciliation'].join('');
equal(portfolioSnapshot.schemaVersion, 'portfolio-ai-snapshot-v2', 'portfolio AI snapshot schema version');
near(portfolioSnapshot.totals.stockMarketValue, 6870, 'portfolio totals include stock market value');
near(portfolioSnapshot.totals.stockUnrealizedPnl, 1527.42, 'portfolio totals include stock unrealized pnl');
near(portfolioSnapshot.totals.totalMarketAwareValueApproximation, 17293.5, 'portfolio totals include market aware approximation');
equal(removedSnapshotKey in portfolioSnapshot, false, 'portfolio AI snapshot excludes removed snapshot data');
assert.equal(portfolioSnapshot.dataLimitations.some((warning) => warning.includes('缺少有效報價')), true, 'portfolio data limitation includes missing quote warning');

const singlePortfolioSnapshot = buildPortfolioAiSnapshot({ mode: 'stock_single', selectedSymbol: 'NVDA', stockTrades, stockPrices, asOf: '2026-06-07T00:00:00.000Z' });
assert.deepEqual(singlePortfolioSnapshot.stocks.symbols, ['NVDA'], 'portfolio single stock mode only includes selected symbol');
near(singlePortfolioSnapshot.stocks.positions[0].currentPrice, 90, 'portfolio single stock includes quote');

const messages = buildPortfolioAiMessages({ snapshot: portfolioSnapshot, mode: 'stock_portfolio' });
const fullPrompt = messages.map((message) => message.content).join('\n');
assert.match(fullPrompt, /不可提供買入、賣出、持有建議/, 'prompt contains no buy sell hold advice limit');
assert.match(fullPrompt, /不可提供目標價/, 'prompt contains no target price limit');
assert.match(fullPrompt, /不可預測股價、利率或回報/, 'prompt contains no prediction limit');
assert.match(fullPrompt, /不可引用 snapshot 以外的市場新聞/, 'prompt contains no external data limit');
assert.match(fullPrompt, /股票報價如出現在 snapshot，只可用於現價、市值、未實現盈虧/, 'prompt allows quote observations only');
assert.match(fullPrompt, /3\. 股票風險訊號/, 'prompt contains stock risk signal section');
assert.match(fullPrompt, /4\. 估值觀察/, 'prompt contains valuation observation section');

assert.equal(AI_MODE_LABELS.total_assets, '整體資產', 'total assets mode label');
assert.equal(AI_MODE_LABELS.stock_portfolio, '股票組合', 'stock portfolio mode label');
assert.equal(AI_MODE_LABELS.stock_single, '單一股票', 'single stock mode label');
assert.equal(AI_MODE_LABELS.cash, '現金', 'cash mode label');
assert.equal(AI_MODE_LABELS.treasury, '美債', 'treasury mode label');
assert.equal(removedSnapshotKey in AI_MODE_LABELS, false, 'removed mode is absent');

assert.equal(isSingleStockModeReady({ mode: 'stock_single', selectedSymbol: '', symbols: ['VOO'] }), false, 'single stock mode requires symbol');
assert.equal(isSingleStockModeReady({ mode: 'stock_single', selectedSymbol: 'VOO', symbols: ['VOO'] }), true, 'single stock mode accepts selected symbol');
assert.equal(isSingleStockModeReady({ mode: 'cash', selectedSymbol: '', symbols: [] }), true, 'non single stock mode does not require symbol');

const markdownReport = [
  '## 數據摘要',
  '- 股票市值已由 snapshot 提供。',
  '',
  '2. 主要觀察',
  '持倉集中於 VOO。',
  '',
  '**股票風險訊號**: GLDM 缺少有效報價。',
  '',
  '估值觀察：VOO 現價高於成本。',
  '',
  '### 集中度 / 風險',
  'VOO 佔比偏高。',
  '',
  '現金流 / 收益：股息資料已記錄。',
  '',
  '資料限制：報價不完整。',
].join('\n');
const parsedSections = parseAiReportSections(markdownReport);
assert.deepEqual(
  parsedSections.map((section) => section.title),
  ['數據摘要', '主要觀察', '股票風險訊號', '估值觀察', '集中度 / 風險', '現金流 / 收益', '資料限制'],
  'markdown report sections are parsed',
);
assert.match(parsedSections[0].content, /股票市值/, 'section content preserved');

assert.equal(detectForbiddenAdvice('建議買入 VOO，目標價 800'), true, 'forbidden advice detector catches buy and target price');
assert.equal(detectForbiddenAdvice('可以賣出持倉，回報預測為 20%'), true, 'forbidden advice detector catches sell and return forecast');
assert.equal(detectForbiddenAdvice('只描述現價相對成本，不提供交易建議。'), false, 'forbidden advice detector allows safety disclaimer');

const unsafeSnapshot = {
  ...portfolioSnapshot,
  apiKey: 'sk-test',
  nested: { accessToken: 'abc', normalValue: 1 },
};
const safeSnapshot = sanitizeAiSnapshotForCopy(unsafeSnapshot);
assert.equal(safeSnapshot.apiKey, '[redacted]', 'snapshot copy redacts api key');
assert.equal(safeSnapshot.nested.accessToken, '[redacted]', 'snapshot copy redacts token');
assert.equal(JSON.stringify(safeSnapshot).includes('sk-test'), false, 'snapshot JSON does not include api key value');
assert.equal(JSON.stringify(safeSnapshot).includes('abc'), false, 'snapshot JSON does not include token value');

const snapshotSummary = buildAiSnapshotSummary(portfolioSnapshot);
assert.equal(snapshotSummary.modeLabel, '整體資產', 'snapshot summary includes mode label');
assert.equal(snapshotSummary.stockSymbolsCount, 3, 'snapshot summary includes stock symbols count');
assert.equal(snapshotSummary.pricedSymbolCount, 2, 'snapshot summary includes priced symbols count');
assert.equal(snapshotSummary.missingPriceCount, 1, 'snapshot summary includes missing price count');
assert.equal(snapshotSummary.riskSignalCount > 0, true, 'snapshot summary includes risk signal count');
near(snapshotSummary.stockMarketValue, 6870, 'snapshot summary includes stock market value');
near(snapshotSummary.stockUnrealizedPnl, 1527.42, 'snapshot summary includes stock unrealized pnl');
assert.equal(snapshotSummary.cashMovementCount, 7, 'snapshot summary includes cash movement count');
assert.equal(snapshotSummary.treasuryHoldingCount, 1, 'snapshot summary includes treasury holdings count');
assert.equal(snapshotSummary.quoteStatus, STOCK_QUOTES_ANALYSIS_LIMITATION, 'snapshot summary includes quote use policy');
assert.equal(snapshotSummary.modules.includes(['Recon', 'ciliation'].join('')), false, 'snapshot summary only lists active modules');
assert.equal(`${removedSnapshotKey}IssueCount` in snapshotSummary, false, 'snapshot summary excludes removed issue count');
