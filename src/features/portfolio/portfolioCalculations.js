import { calculatePortfolioCashSummary } from '../cash/cashCalculations.js';
import { buildReconciliationReport } from '../reconciliation/reconciliationCalculations.js';
import { calculateStockPortfolioTotals, calculateStockPositions } from '../stocks/stockCalculations.js';
import { attachPricesToPositions, calculateStockMarketTotals } from '../prices/stockPriceCalculations.js';

const toNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const getSnapshotSortKey = (snapshot = {}) => `${snapshot.date || ''}:${snapshot.createdAt || ''}`;

export const getLatestReconciliationSnapshot = (snapshots = []) =>
  [...snapshots].sort((a, b) => getSnapshotSortKey(b).localeCompare(getSnapshotSortKey(a)))[0] || null;

export const buildPortfolioOverview = ({
  treasuryMetrics = {},
  stockTrades = [],
  stockPrices = [],
  cashMovements = [],
  reconciliationSnapshots = [],
} = {}) => {
  const stockPositions = calculateStockPositions(stockTrades);
  const stockTotals = calculateStockPortfolioTotals(stockPositions);
  const priceMap = stockPrices.reduce((map, price) => {
    const symbol = String(price.symbol || price.id || '').trim().toUpperCase();
    if (symbol) map[symbol] = { ...price, symbol };
    return map;
  }, {});
  const stockPositionsWithPrices = attachPricesToPositions(stockPositions, priceMap);
  const stockMarketTotals = calculateStockMarketTotals(stockPositionsWithPrices);
  const cashSummary = calculatePortfolioCashSummary(cashMovements, stockTrades);
  const latestSnapshot = getLatestReconciliationSnapshot(reconciliationSnapshots);
  const reconciliationReport = latestSnapshot
    ? buildReconciliationReport({ snapshot: latestSnapshot, stockTrades, cashMovements })
    : null;

  return {
    treasury: {
      cleanMarketValue: toNumber(treasuryMetrics.totalMarketValue),
      fullMarketValue: toNumber(treasuryMetrics.totalFullMarketValue),
      unrealizedPnl: toNumber(treasuryMetrics.totalUnrealizedPnL),
      weightedAvgYtm: Number.isFinite(treasuryMetrics.totalWeightYTM) ? treasuryMetrics.totalWeightYTM : null,
      monthlyAvgIncome: toNumber(treasuryMetrics.monthlyAvgIncome),
    },
    stocks: {
      symbolCount: stockPositions.length,
      remainingCost: stockTotals.remainingCost,
      realizedPnl: stockTotals.realizedPnl,
      cashImpact: stockTotals.cashImpact,
      hasMarketValue: stockMarketTotals.pricedSymbolCount > 0,
      marketValue: stockMarketTotals.totalMarketValue,
      unrealizedPnl: stockMarketTotals.totalUnrealizedPnl,
      pricedSymbolCount: stockMarketTotals.pricedSymbolCount,
      missingPriceCount: stockMarketTotals.missingPriceCount,
      stalePriceCount: stockMarketTotals.stalePriceCount,
      marketValueLabel: stockMarketTotals.pricedSymbolCount > 0 ? '已接報價' : '暫未接報價',
    },
    cash: cashSummary,
    reconciliation: {
      hasSnapshot: Boolean(latestSnapshot),
      latestSnapshot,
      latestDate: latestSnapshot?.date || '',
      issueCount: reconciliationReport?.summary.issueCount ?? null,
      cashDifference: reconciliationReport?.summary.cashDifference ?? null,
      holdingsDifferenceCount: reconciliationReport
        ? reconciliationReport.holdingComparisons.filter((item) => item.status !== 'OK').length
        : null,
    },
  };
};
