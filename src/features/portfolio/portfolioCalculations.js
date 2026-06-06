import { calculatePortfolioCashSummary } from '../cash/cashCalculations.js';
import { buildReconciliationReport } from '../reconciliation/reconciliationCalculations.js';
import { calculateStockPortfolioTotals, calculateStockPositions } from '../stocks/stockCalculations.js';

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
  cashMovements = [],
  reconciliationSnapshots = [],
} = {}) => {
  const stockPositions = calculateStockPositions(stockTrades);
  const stockTotals = calculateStockPortfolioTotals(stockPositions);
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
