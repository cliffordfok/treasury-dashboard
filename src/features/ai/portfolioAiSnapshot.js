import { calculateCashMovementSummary, calculatePortfolioCashSummary, getCashMovementImpact } from '../cash/cashCalculations.js';
import { attachPricesToPositions, calculateStockMarketTotals } from '../prices/stockPriceCalculations.js';
import { getStockPriceMap } from '../prices/stockPriceFirestore.js';
import { calculateStockPortfolioTotals, calculateStockPositions, getStockTradeCashImpact, normalizeSymbol, toNumber } from '../stocks/stockCalculations.js';

export const AI_ANALYSIS_MODES = [
  'treasury',
  'stock_single',
  'stock_portfolio',
  'cash',
  'total_assets',
];

export const STOCK_QUOTES_ANALYSIS_LIMITATION =
  '股票報價只用於現價、市值、未實現盈虧、集中度及風險訊號觀察；AI 不提供買入、賣出、持有建議、目標價或股價預測。';

export const STOCK_QUOTES_DISABLED_LIMITATION = STOCK_QUOTES_ANALYSIS_LIMITATION;

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

const buildValuationObservation = (position = {}) => {
  if (position.currentPrice == null || position.unrealizedPnl == null) {
    return '資料不足：未有有效現價。';
  }
  const pnlPercent = Number.isFinite(Number(position.unrealizedPnlPercent)) ? round(position.unrealizedPnlPercent, 2) : null;
  if (position.unrealizedPnl > 0) return `現價高於剩餘成本，未實現盈虧約 +${round(position.unrealizedPnl)}${pnlPercent == null ? '' : `（${pnlPercent}%）`}。`;
  if (position.unrealizedPnl < 0) return `現價低於剩餘成本，未實現盈虧約 ${round(position.unrealizedPnl)}${pnlPercent == null ? '' : `（${pnlPercent}%）`}。`;
  return '現價約等於剩餘成本，未實現盈虧接近 0。';
};

const buildStockRiskSignals = (positions = [], marketTotals = {}) => {
  const signals = [];
  const totalMarketValue = toNumber(marketTotals.totalMarketValue);
  const totalRemainingCost = positions.reduce((total, position) => total + Math.max(0, toNumber(position.remainingCost)), 0);

  positions.forEach((position) => {
    const marketValue = toNumber(position.marketValue);
    const cost = toNumber(position.remainingCost);
    const costConcentration = totalRemainingCost > 0 ? (cost / totalRemainingCost) * 100 : null;
    const marketConcentration = totalMarketValue > 0 && marketValue > 0 ? (marketValue / totalMarketValue) * 100 : null;

    if (costConcentration != null && costConcentration >= 25) {
      signals.push({
        symbol: position.symbol,
        type: 'cost_concentration',
        severity: costConcentration >= 40 ? 'high' : 'medium',
        detail: `成本集中度約 ${round(costConcentration, 2)}%。`,
      });
    }
    if (marketConcentration != null && marketConcentration >= 25) {
      signals.push({
        symbol: position.symbol,
        type: 'market_value_concentration',
        severity: marketConcentration >= 40 ? 'high' : 'medium',
        detail: `市值集中度約 ${round(marketConcentration, 2)}%。`,
      });
    }
    if (Number.isFinite(Number(position.unrealizedPnlPercent)) && Math.abs(position.unrealizedPnlPercent) >= 20) {
      signals.push({
        symbol: position.symbol,
        type: 'large_unrealized_move',
        severity: Math.abs(position.unrealizedPnlPercent) >= 40 ? 'high' : 'medium',
        detail: `未實現盈虧幅度約 ${round(position.unrealizedPnlPercent, 2)}%。`,
      });
    }
    if (position.isPriceStale) {
      signals.push({
        symbol: position.symbol,
        type: 'stale_quote',
        severity: 'low',
        detail: '報價可能已過期。',
      });
    }
  });

  if (marketTotals.missingPriceCount > 0) {
    signals.push({
      symbol: '',
      type: 'missing_quotes',
      severity: 'medium',
      detail: `${marketTotals.missingPriceCount} 個持倉缺少有效報價。`,
    });
  }

  return signals;
};

export const buildStockAiSnapshot = (stockTrades = [], stockSummary = null, options = {}) => {
  const selectedSymbol = normalizeSymbol(options.symbol);
  const stockPrices = options.stockPrices || [];
  const filteredTrades = selectedSymbol
    ? stockTrades.filter((trade) => normalizeSymbol(trade.symbol) === selectedSymbol)
    : stockTrades;
  const positions = stockSummary?.positions || calculateStockPositions(filteredTrades);
  const priceMap = getStockPriceMap(stockPrices);
  const positionsWithPrices = attachPricesToPositions(positions, priceMap);
  const activePositions = positionsWithPrices.filter((position) => nonZero(position.quantity) || nonZero(position.remainingCost));
  const totals = stockSummary?.totals || calculateStockPortfolioTotals(positions);
  const marketTotals = calculateStockMarketTotals(activePositions);
  const totalRemainingCost = toNumber(totals.remainingCost);
  const totalMarketValue = toNumber(marketTotals.totalMarketValue);
  const largestPositions = topByAbsAmount(activePositions, (position) => toNumber(position.remainingCost), 5)
    .map((position) => ({
      symbol: position.symbol,
      shares: round(position.quantity, 6),
      averageCost: round(position.averageCost),
      remainingCost: round(position.remainingCost),
      currentPrice: position.currentPrice == null ? null : round(position.currentPrice, 4),
      marketValue: position.marketValue == null ? null : round(position.marketValue),
      unrealizedPnl: position.unrealizedPnl == null ? null : round(position.unrealizedPnl),
      unrealizedPnlPercent: position.unrealizedPnlPercent == null ? null : round(position.unrealizedPnlPercent, 2),
      realizedPnl: round(position.realizedPnl),
      concentrationPercent: totalRemainingCost > 0 ? round((toNumber(position.remainingCost) / totalRemainingCost) * 100, 2) : null,
      marketValueConcentrationPercent: totalMarketValue > 0 && position.marketValue != null ? round((toNumber(position.marketValue) / totalMarketValue) * 100, 2) : null,
    }));

  const warnings = [];
  if (filteredTrades.length === 0) warnings.push(selectedSymbol ? `沒有 ${selectedSymbol} 的股票交易紀錄。` : '沒有股票交易資料。');
  if (activePositions.length === 0) warnings.push('沒有目前仍持有的股票 / ETF 持倉。');
  if (marketTotals.missingPriceCount > 0) warnings.push(`${marketTotals.missingPriceCount} 個持倉缺少有效報價。`);
  if (marketTotals.stalePriceCount > 0) warnings.push(`${marketTotals.stalePriceCount} 個持倉報價可能已過期。`);

  return {
    mode: selectedSymbol ? 'stock_single' : 'stock_portfolio',
    selectedSymbol,
    holdingCount: activePositions.length,
    tradeCount: filteredTrades.length,
    symbols: activePositions.map((position) => position.symbol),
    quoteSummary: {
      provider: 'twelve_data_or_manual',
      pricedSymbolCount: marketTotals.pricedSymbolCount,
      missingPriceCount: marketTotals.missingPriceCount,
      stalePriceCount: marketTotals.stalePriceCount,
      totalMarketValue: round(marketTotals.totalMarketValue),
      totalUnrealizedPnl: round(marketTotals.totalUnrealizedPnl),
      quoteUsePolicy: STOCK_QUOTES_ANALYSIS_LIMITATION,
    },
    positions: activePositions.map((position) => ({
      symbol: position.symbol,
      shares: round(position.quantity, 6),
      averageCost: round(position.averageCost),
      remainingCost: round(position.remainingCost),
      currentPrice: position.currentPrice == null ? null : round(position.currentPrice, 4),
      priceAsOf: position.priceAsOf || '',
      priceSource: position.priceSource || '',
      marketValue: position.marketValue == null ? null : round(position.marketValue),
      unrealizedPnl: position.unrealizedPnl == null ? null : round(position.unrealizedPnl),
      unrealizedPnlPercent: position.unrealizedPnlPercent == null ? null : round(position.unrealizedPnlPercent, 2),
      realizedPnl: round(position.realizedPnl),
      stockTradeCashImpact: round(position.cashImpact),
      tradeCount: position.tradeCount,
      valuationObservation: buildValuationObservation(position),
      isPriceStale: Boolean(position.isPriceStale),
    })),
    totals: {
      remainingCost: round(totals.remainingCost),
      realizedPnl: round(totals.realizedPnl),
      stockTradeCashImpact: round(totals.cashImpact),
      totalFees: round(totals.totalFees),
      marketValue: round(marketTotals.totalMarketValue),
      unrealizedPnl: round(marketTotals.totalUnrealizedPnl),
    },
    largestPositionsByRemainingCost: largestPositions,
    largestPositionsByMarketValue: topByAbsAmount(activePositions.filter((position) => position.marketValue != null), (position) => toNumber(position.marketValue), 5)
      .map((position) => ({
        symbol: position.symbol,
        marketValue: round(position.marketValue),
        percent: totalMarketValue > 0 ? round((toNumber(position.marketValue) / totalMarketValue) * 100, 2) : null,
      })),
    concentrationByRemainingCost: largestPositions.map((position) => ({
      symbol: position.symbol,
      percent: position.concentrationPercent,
    })),
    concentrationByMarketValue: largestPositions
      .filter((position) => position.marketValueConcentrationPercent != null)
      .map((position) => ({
        symbol: position.symbol,
        percent: position.marketValueConcentrationPercent,
      })),
    riskSignals: buildStockRiskSignals(activePositions, marketTotals),
    valuationObservations: activePositions.map((position) => ({
      symbol: position.symbol,
      observation: buildValuationObservation(position),
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
  stockPrices = [],
  cashMovements = [],
  treasuryData = {},
  treasurySummary = {},
  asOf = new Date().toISOString(),
} = {}) => {
  const cashSummary = calculatePortfolioCashSummary(cashMovements, stockTrades);
  const stocks = buildStockAiSnapshot(stockTrades, null, {
    symbol: mode === 'stock_single' ? selectedSymbol : '',
    stockPrices,
  });
  const allStocks = buildStockAiSnapshot(stockTrades, null, { stockPrices });
  const cash = buildCashAiSnapshot(cashMovements, cashSummary);
  const treasuries = buildTreasuryAiSnapshot(treasuryData, treasurySummary);
  const dataLimitations = [
    ...stocks.missingDataWarnings,
    ...cash.missingDataWarnings,
    ...treasuries.missingDataWarnings,
  ];

  return {
    schemaVersion: 'portfolio-ai-snapshot-v2',
    asOf,
    mode: AI_ANALYSIS_MODES.includes(mode) ? mode : 'total_assets',
    selectedSymbol: normalizeSymbol(selectedSymbol),
    totals: {
      stockRemainingCost: round(allStocks.totals.remainingCost),
      stockRealizedPnl: round(allStocks.totals.realizedPnl),
      stockTradeCashImpact: round(allStocks.totals.stockTradeCashImpact),
      stockMarketValue: round(allStocks.totals.marketValue),
      stockUnrealizedPnl: round(allStocks.totals.unrealizedPnl),
      calculatedCashBalance: round(cash.cashBalance),
      treasuryFullMarketValue: round(treasuries.fullMarketValue),
      totalBookValueApproximation: round(allStocks.totals.remainingCost + cash.cashBalance + treasuries.fullMarketValue),
      totalMarketAwareValueApproximation: round(allStocks.totals.marketValue + cash.cashBalance + treasuries.fullMarketValue),
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
