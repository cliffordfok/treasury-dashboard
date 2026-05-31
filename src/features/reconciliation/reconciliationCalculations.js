import { calculatePortfolioCashSummary } from '../cash/cashCalculations.js';
import { calculateStockPositions, normalizeSymbol, toNumber } from '../stocks/stockCalculations.js';

export const CASH_STATUS = {
  OK: 'OK',
  SMALL_DIFF: 'SMALL_DIFF',
  DIFF: 'DIFF',
};

export const HOLDING_STATUS = {
  OK: 'OK',
  QTY_DIFF: 'QTY_DIFF',
  COST_DIFF: 'COST_DIFF',
  MISSING_IN_BROKER: 'MISSING_IN_BROKER',
  MISSING_IN_SYSTEM: 'MISSING_IN_SYSTEM',
};

export const QUANTITY_TOLERANCE = 0.000001;
export const CASH_TOLERANCE = 0.01;
export const SMALL_CASH_TOLERANCE = 1;
export const COST_TOLERANCE = 0.01;

const hasNumber = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));

const getCashStatus = (difference) => {
  const absDiff = Math.abs(difference);
  if (absDiff <= CASH_TOLERANCE) return CASH_STATUS.OK;
  if (absDiff <= SMALL_CASH_TOLERANCE) return CASH_STATUS.SMALL_DIFF;
  return CASH_STATUS.DIFF;
};

const normalizeBrokerHoldings = (holdings = []) => {
  const map = new Map();
  holdings.forEach((holding) => {
    const symbol = normalizeSymbol(holding.symbol);
    if (!symbol) return;
    map.set(symbol, {
      symbol,
      brokerQuantity: toNumber(holding.brokerQuantity),
      brokerCostBasis: hasNumber(holding.brokerCostBasis) ? toNumber(holding.brokerCostBasis) : null,
      brokerMarketValue: hasNumber(holding.brokerMarketValue) ? toNumber(holding.brokerMarketValue) : null,
      notes: holding.notes || '',
    });
  });
  return map;
};

const getHoldingStatus = ({ hasSystem, hasBroker, quantityDifference, costDifference }) => {
  if (hasSystem && !hasBroker) return HOLDING_STATUS.MISSING_IN_BROKER;
  if (!hasSystem && hasBroker) return HOLDING_STATUS.MISSING_IN_SYSTEM;
  if (Math.abs(quantityDifference) > QUANTITY_TOLERANCE) return HOLDING_STATUS.QTY_DIFF;
  if (costDifference !== null && Math.abs(costDifference) > COST_TOLERANCE) return HOLDING_STATUS.COST_DIFF;
  return HOLDING_STATUS.OK;
};

export const buildReconciliationReport = ({ snapshot, stockTrades = [], cashMovements = [] }) => {
  const cashSummary = calculatePortfolioCashSummary(cashMovements, stockTrades);
  const systemCashBalance = cashSummary.calculatedCashBalance;
  const brokerCashBalance = toNumber(snapshot?.brokerCashBalance);
  const cashDifference = brokerCashBalance - systemCashBalance;
  const cashComparison = {
    systemCashBalance,
    brokerCashBalance,
    difference: cashDifference,
    status: getCashStatus(cashDifference),
  };

  const systemPositions = new Map(
    calculateStockPositions(stockTrades)
      .filter((position) => Math.abs(position.quantity) > QUANTITY_TOLERANCE || Math.abs(position.remainingCost) > COST_TOLERANCE)
      .map((position) => [position.symbol, position]),
  );
  const brokerHoldings = normalizeBrokerHoldings(snapshot?.holdings);
  const symbols = Array.from(new Set([...systemPositions.keys(), ...brokerHoldings.keys()])).sort((a, b) => a.localeCompare(b));

  const holdingComparisons = symbols.map((symbol) => {
    const system = systemPositions.get(symbol);
    const broker = brokerHoldings.get(symbol);
    const hasSystem = Boolean(system);
    const hasBroker = Boolean(broker);
    const systemQuantity = system?.quantity || 0;
    const brokerQuantity = broker?.brokerQuantity || 0;
    const quantityDifference = brokerQuantity - systemQuantity;
    const systemCostBasis = system?.remainingCost || 0;
    const brokerCostBasis = broker?.brokerCostBasis ?? null;
    const costDifference = brokerCostBasis === null ? null : brokerCostBasis - systemCostBasis;
    const status = getHoldingStatus({ hasSystem, hasBroker, quantityDifference, costDifference });

    return {
      symbol,
      systemQuantity,
      brokerQuantity,
      quantityDifference,
      systemCostBasis,
      brokerCostBasis,
      costDifference,
      brokerMarketValue: broker?.brokerMarketValue ?? null,
      status,
    };
  });

  const totalSystemCost = holdingComparisons.reduce((total, item) => total + item.systemCostBasis, 0);
  const totalBrokerCost = holdingComparisons.reduce((total, item) => total + (item.brokerCostBasis ?? 0), 0);
  const totalCostDifference = totalBrokerCost - totalSystemCost;
  const holdingIssueCount = holdingComparisons.filter((item) => item.status !== HOLDING_STATUS.OK).length;
  const cashIssueCount = cashComparison.status === CASH_STATUS.OK ? 0 : 1;

  return {
    cashComparison,
    holdingComparisons,
    summary: {
      totalSystemCost,
      totalBrokerCost,
      totalCostDifference,
      systemCashBalance,
      brokerCashBalance,
      cashDifference,
      issueCount: holdingIssueCount + cashIssueCount,
      okCount: holdingComparisons.length - holdingIssueCount + (cashIssueCount ? 0 : 1),
    },
  };
};
