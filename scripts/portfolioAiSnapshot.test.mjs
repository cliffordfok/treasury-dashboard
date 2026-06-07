import assert from 'node:assert/strict';
import { AI_MODE_LABELS, buildPortfolioAiMessages } from '../src/features/ai/portfolioAiPrompts.js';
import { buildAiSnapshotSummary, detectForbiddenAdvice, isSingleStockModeReady, parseAiReportSections, sanitizeAiSnapshotForCopy } from '../src/features/ai/portfolioAiReport.js';
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
  treasuryData: { trades: [{ cusip: '91282C', status: 'active', type: 't-note', side: 'buy', maturityDate: '2030-05-31', faceValue: 1000, cleanPrice: 99, couponRate: 4 }] },
  treasurySummary: { totalFullMarketValue: 990, totalMarketValue: 990, totalUnrealizedPnL: 0, totalFace: 1000, totalWeightYTM: 4, monthlyAvgIncome: 3.33 },
  asOf: '2026-06-07T00:00:00.000Z',
});
const removedSnapshotKey = ['recon', 'ciliation'].join('');
equal('marketValue' in portfolioSnapshot.stocks.totals, false, 'total assets snapshot does not use quote market value');
equal('stockUnrealizedPnl' in portfolioSnapshot.totals, false, 'total assets snapshot does not include stock unrealized pnl');
equal(removedSnapshotKey in portfolioSnapshot, false, 'portfolio AI snapshot excludes removed snapshot data');
assert.equal(portfolioSnapshot.dataLimitations[0], STOCK_QUOTES_DISABLED_LIMITATION, 'portfolio data limitation includes missing quotes');

const singlePortfolioSnapshot = buildPortfolioAiSnapshot({ mode: 'stock_single', selectedSymbol: 'NVDA', stockTrades, asOf: '2026-06-07T00:00:00.000Z' });
assert.deepEqual(singlePortfolioSnapshot.stocks.symbols, ['NVDA'], 'portfolio single stock mode only includes selected symbol');

const messages = buildPortfolioAiMessages({ snapshot: portfolioSnapshot, mode: 'stock_portfolio' });
const fullPrompt = messages.map((message) => message.content).join('\n');
assert.match(fullPrompt, /不可提供買入、賣出、持有建議/, 'prompt contains no buy sell advice limit');
assert.match(fullPrompt, /不可提供目標價/, 'prompt contains no target price limit');
assert.match(fullPrompt, /不可預測股價/, 'prompt contains no stock prediction limit');
assert.match(fullPrompt, /不可引用 snapshot 以外/, 'prompt contains no external data limit');
assert.match(fullPrompt, /AI 分析目前不使用股票報價/, 'prompt contains quote limitation');
assert.match(fullPrompt, /1\. 數據摘要/, 'prompt contains fixed output format');
assert.match(fullPrompt, /5\. 資料限制/, 'prompt output format uses data limitation section');

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
  '- 股票成本約 100。',
  '',
  '2. 主要觀察',
  '沒有使用報價資料。',
  '',
  '**集中度 / 風險**: VOO 佔比較高。',
  '',
  '現金流 / 收益：股息已記錄。',
  '',
  '### 資料限制',
  '資料不足。',
].join('\n');
const parsedSections = parseAiReportSections(markdownReport);
assert.deepEqual(parsedSections.map((section) => section.title), ['數據摘要', '主要觀察', '集中度 / 風險', '現金流 / 收益', '資料限制'], 'markdown report sections are parsed');
assert.match(parsedSections[0].content, /股票成本/, 'section content preserved');

assert.equal(detectForbiddenAdvice('建議買入 VOO，目標價 800'), true, 'forbidden advice detector catches buy and target price');
assert.equal(detectForbiddenAdvice('應該賣出目前持倉'), true, 'forbidden advice detector catches sell wording');
assert.equal(detectForbiddenAdvice('只根據帳本資料作中性摘要，不構成買賣建議。'), false, 'forbidden advice detector allows safety disclaimer');

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
assert.equal(snapshotSummary.stockSymbolsCount, 2, 'snapshot summary includes stock symbols count');
assert.equal(snapshotSummary.cashMovementCount, 7, 'snapshot summary includes cash movement count');
assert.equal(snapshotSummary.treasuryHoldingCount, 1, 'snapshot summary includes treasury holdings count');
assert.equal(snapshotSummary.quoteStatus, STOCK_QUOTES_DISABLED_LIMITATION, 'snapshot summary includes quote disabled status');
assert.equal(snapshotSummary.modules.includes(['Recon', 'ciliation'].join('')), false, 'snapshot summary only lists active modules');
assert.equal(`${removedSnapshotKey}IssueCount` in snapshotSummary, false, 'snapshot summary excludes removed issue count');
