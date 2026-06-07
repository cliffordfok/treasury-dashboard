import { calculateCashMovementSummary, calculatePortfolioCashSummary, getCashMovementImpact } from '../cash/cashCalculations.js';
import { calculateStockPortfolioTotals, calculateStockPositions, getStockTradeCashImpact, normalizeSymbol, toNumber } from '../stocks/stockCalculations.js';

export const AI_ANALYSIS_MODES = [
  'treasury',
  'stock_single',
  'stock_portfolio',
  'cash',
  'total_assets',
];

export const STOCK_QUOTES_DISABLED_LIMITATION =
  'AI 分析目前不使用股票報價，因此本分析以成本、持倉及現金流為主，不包含即時市值及未實現盈虧。';

const round = (value, digits = 2) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
};

const nonZero = (value) => Math.abs(toNumber(value)) > 0.000001;

const topByAbsAmount = (items = [], getAmount, limit = 5) =>
  [...items]
    .sort((a, b) => Math.abs(getAmount(b)) - Math.abs(getAmount(a)))
    .slice(0, limit);

const summarizeRecent = (items = [], dateField = 'date', limit = 8) =>
  [...items]
    .sort((a, b) => `${b[dateField] || ''}:${b.createdAt || ''}`.localeCompare(`${a[dateField] || ''}:${a.createdAt || ''}`))
    .slice(0, limit);

export const buildStockAiSnapshot = (stockTrades = [], stockSummary = null, options = {}) => {
  const selectedSymbol = normalizeSymbol(options.symbol);
  const filteredTrades = selectedSymbol
    ? stockTrades.filter((trade) => normalizeSymbol(trade.symbol) === selectedSymbol)
    : stockTrades;
  const positions = stockSummary?.positions || calculateStockPositions(filteredTrades);
  const activePositions = positions.filter((position) => nonZero(position.quantity) || nonZero(position.remainingCost));
  const totals = stockSummary?.totals || calculateStockPortfolioTotals(positions);
  const totalRemainingCost = toNumber(totals.remainingCost);
  const largestPositions = topByAbsAmount(activePositions, (position) => toNumber(position.remainingCost), 5)
    .map((position) => ({
      symbol: position.symbol,
      shares: round(position.quantity, 6),
      averageCost: round(position.averageCost),
      remainingCost: round(position.remainingCost),
      realizedPnl: round(position.realizedPnl),
      concentrationPercent: totalRemainingCost > 0 ? round((toNumber(position.remainingCost) / totalRemainingCost) * 100, 2) : null,
    }));

  const warnings = [STOCK_QUOTES_DISABLED_LIMITATION];
  if (filteredTrades.length === 0) warnings.push(selectedSymbol ? `沒有 ${selectedSymbol} 的股票交易紀錄。` : '沒有股票交易資料。');
  if (activePositions.length === 0) warnings.push('沒有目前仍持有的股票 / ETF 持倉。');

  return {
    mode: selectedSymbol ? 'stock_single' : 'stock_portfolio',
    selectedSymbol,
    holdingCount: activePositions.length,
    tradeCount: filteredTrades.length,
    symbols: activePositions.map((position) => position.symbol),
    positions: activePositions.map((position) => ({
      symbol: position.symbol,
      shares: round(position.quantity, 6),
      averageCost: round(position.averageCost),
      remainingCost: round(position.remainingCost),
      realizedPnl: round(position.realizedPnl),
      stockTradeCashImpact: round(position.cashImpact),
      tradeCount: position.tradeCount,
    })),
    totals: {
      remainingCost: round(totals.remainingCost),
      realizedPnl: round(totals.realizedPnl),
      stockTradeCashImpact: round(totals.cashImpact),
      totalFees: round(totals.totalFees),
    },
    largestPositionsByRemainingCost: largestPositions,
    concentrationByRemainingCost: largestPositions.map((position) => ({
      symbol: position.symbol,
      percent: position.concentrationPercent,
    })),
    recentTrades: summarizeRecent(filteredTrades, 'tradeDate', 8).map((trade) => ({
      symbol: normalizeSymbol(trade.symbol),
      side: trade.side,
      tradeDate: trade.tradeDate,
      quantity: round(trade.quantity, 6),
      price: round(trade.price, 4),
      cashImpact: round(getStockTradeCashImpact(trade)),
    })),
    missingDataWarnings: warnings,
  };
};

export const buildCashAiSnapshot = (cashMovements = [], cashSummary = null) => {
  const movementSummary = cashSummary || calculateCashMovementSummary(cashMovements);
  const byType = cashMovements.reduce((map, movement) => {
    const type = movement.type || 'unknown';
    if (!map[type]) map[type] = { count: 0, cashImpact: 0 };
    map[type].count += 1;
    map[type].cashImpact += getCashMovementImpact(movement);
    return map;
  }, {});

  const largeMovements = topByAbsAmount(cashMovements, getCashMovementImpact, 5).map((movement) => ({
    type: movement.type,
    date: movement.date,
    symbol: normalizeSymbol(movement.symbol),
    cashImpact: round(getCashMovementImpact(movement)),
    notes: movement.notes || '',
  }));

  return {
    cashBalance: round(movementSummary.calculatedCashBalance ?? movementSummary.cashMovementsTotal),
    cashMovementsTotal: round(movementSummary.cashMovementsTotal),
    stockTradeCashImpact: round(movementSummary.stockTradeCashImpact),
    deposits: round((byType.deposit?.cashImpact || 0) + (byType.opening_balance?.cashImpact || 0)),
    withdrawals: round(Math.abs(byType.withdrawal?.cashImpact || 0)),
    dividends: round(movementSummary.dividendNetReceived),
    interest: round(byType.interest?.cashImpact || 0),
    fees: round(movementSummary.fees),
    withholdingTax: round(movementSummary.dividendWithholdingTax),
    movementCount: cashMovements.length,
    byType,
    largeMovements,
    missingDataWarnings: cashMovements.length === 0 ? ['沒有現金流水資料。'] : [],
  };
};

export const buildTreasuryAiSnapshot = (treasuryData = {}, treasurySummary = {}) => {
  const trades = treasuryData.trades || [];
  const activeTrades = trades.filter((trade) => (trade.status || 'active') === 'active');
  const maturityBuckets = activeTrades.reduce((buckets, trade) => {
    const maturityYear = String(trade.maturityDate || '').slice(0, 4) || 'unknown';
    buckets[maturityYear] = (buckets[maturityYear] || 0) + toNumber(trade.faceValue);
    return buckets;
  }, {});

  return {
    holdingCount: activeTrades.length,
    totalFaceValue: round(treasurySummary.totalFace),
    cleanMarketValue: round(treasurySummary.totalMarketValue),
    fullMarketValue: round(treasurySummary.totalFullMarketValue),
    unrealizedPnl: round(treasurySummary.totalUnrealizedPnL),
    weightedAvgYtm: Number.isFinite(treasurySummary.totalWeightYTM) ? round(treasurySummary.totalWeightYTM, 4) : null,
    monthlyAverageInterest: round(treasurySummary.monthlyAvgIncome),
    maturityDistributionByYear: maturityBuckets,
    holdings: activeTrades.slice(0, 20).map((trade) => ({
      cusip: trade.cusip || '',
      type: trade.type,
      side: trade.side,
      maturityDate: trade.maturityDate,
      faceValue: round(trade.faceValue),
      cleanPrice: round(trade.cleanPrice, 4),
      couponRate: round(trade.couponRate, 4),
    })),
    missingDataWarnings: activeTrades.length === 0 ? ['沒有美債持倉資料。'] : [],
  };
};

export const buildPortfolioAiSnapshot = ({
  mode = 'total_assets',
  selectedSymbol = '',
  stockTrades = [],
  cashMovements = [],
  treasuryData = {},
  treasurySummary = {},
  asOf = new Date().toISOString(),
} = {}) => {
  const cashSummary = calculatePortfolioCashSummary(cashMovements, stockTrades);
  const stocks = buildStockAiSnapshot(stockTrades, null, { symbol: mode === 'stock_single' ? selectedSymbol : '' });
  const allStocks = buildStockAiSnapshot(stockTrades);
  const cash = buildCashAiSnapshot(cashMovements, cashSummary);
  const treasuries = buildTreasuryAiSnapshot(treasuryData, treasurySummary);
  const dataLimitations = [
    STOCK_QUOTES_DISABLED_LIMITATION,
    ...stocks.missingDataWarnings,
    ...cash.missingDataWarnings,
    ...treasuries.missingDataWarnings,
  ];

  return {
    schemaVersion: 'portfolio-ai-snapshot-v1',
    asOf,
    mode: AI_ANALYSIS_MODES.includes(mode) ? mode : 'total_assets',
    selectedSymbol: normalizeSymbol(selectedSymbol),
    totals: {
      stockRemainingCost: round(allStocks.totals.remainingCost),
      stockRealizedPnl: round(allStocks.totals.realizedPnl),
      stockTradeCashImpact: round(allStocks.totals.stockTradeCashImpact),
      calculatedCashBalance: round(cash.cashBalance),
      treasuryFullMarketValue: round(treasuries.fullMarketValue),
      totalBookValueApproximation: round(allStocks.totals.remainingCost + cash.cashBalance + treasuries.fullMarketValue),
      dividendNetReceived: round(cash.dividends),
      interest: round(cash.interest + treasuries.monthlyAverageInterest),
    },
    stocks,
    allStocks,
    cash,
    treasuries,
    dataLimitations: [...new Set(dataLimitations.filter(Boolean))],
  };
};
