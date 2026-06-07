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

const round = (value, digits = 2) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
};

export const buildBookValueAssetAllocation = ({
  cashBalance = 0,
  stockRemainingCost = 0,
  treasuryPrincipal = 0,
} = {}) => {
  const inputs = [
    { key: 'cash', label: '現金', amount: toNumber(cashBalance), warningIfNegative: '現金為負數，未納入圓形圖比例。' },
    { key: 'stocks', label: '美股 / ETF', amount: toNumber(stockRemainingCost) },
    { key: 'treasuries', label: '美債', amount: toNumber(treasuryPrincipal) },
  ];
  const warnings = inputs
    .filter((item) => item.amount < 0 && item.warningIfNegative)
    .map((item) => item.warningIfNegative);
  const positiveItems = inputs.filter((item) => item.amount > 0);
  const totalAmount = positiveItems.reduce((total, item) => total + item.amount, 0);
  const rows = totalAmount > 0
    ? positiveItems.map((item) => ({
      key: item.key,
      label: item.label,
      amount: round(item.amount),
      percent: round((item.amount / totalAmount) * 100, 2),
    }))
    : [];

  return {
    rows,
    totalAmount: round(totalAmount),
    warnings,
    isEmpty: rows.length === 0,
  };
};

export const buildPortfolioOverview = ({
  treasuryMetrics = {},
  stockTrades = [],
  cashMovements = [],
  reconciliationSnapshots = [],
} = {}) => {
  const stockPositions = calculateStockPositions(stockTrades);
  const stockTotals = calculateStockPortfolioTotals(stockPositions);
  const cashSummary = calculatePortfolioCashSummary(cashMovements, stockTrades);
  const treasuryPrincipal = toNumber(treasuryMetrics.totalFace);
  const latestSnapshot = getLatestReconciliationSnapshot(reconciliationSnapshots);
  const reconciliationReport = latestSnapshot
    ? buildReconciliationReport({ snapshot: latestSnapshot, stockTrades, cashMovements })
    : null;
  const assetAllocation = buildBookValueAssetAllocation({
    cashBalance: cashSummary.calculatedCashBalance,
    stockRemainingCost: stockTotals.remainingCost,
    treasuryPrincipal,
  });

  return {
    treasury: {
      principalValue: treasuryPrincipal,
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
    assetAllocation,
  };
};
