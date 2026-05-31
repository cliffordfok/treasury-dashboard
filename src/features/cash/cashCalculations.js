import { getStockTradeCashImpact, toNumber } from '../stocks/stockCalculations.js';

export const CASH_MOVEMENT_TYPES = [
  'opening_balance',
  'deposit',
  'withdrawal',
  'dividend',
  'interest',
  'fee',
  'withholding_tax',
  'adjustment',
];

export const CASH_MOVEMENT_TYPE_LABELS = {
  opening_balance: 'Opening Balance',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  dividend: 'Dividend',
  interest: 'Interest',
  fee: 'Fee',
  withholding_tax: 'Withholding Tax',
  adjustment: 'Adjustment',
};

export const hasNumericValue = (value) => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));

export const getCashMovementImpact = (movement) => {
  const type = movement?.type;
  const amount = toNumber(movement?.amount);
  const grossAmount = toNumber(movement?.grossAmount);
  const withholdingTax = toNumber(movement?.withholdingTax);

  switch (type) {
    case 'opening_balance':
    case 'deposit':
    case 'interest':
      return amount;
    case 'withdrawal':
    case 'fee':
    case 'withholding_tax':
      return -amount;
    case 'adjustment':
      return amount;
    case 'dividend':
      if (hasNumericValue(movement?.netAmount)) return toNumber(movement.netAmount);
      if (hasNumericValue(movement?.grossAmount) && hasNumericValue(movement?.withholdingTax)) {
        return grossAmount - withholdingTax;
      }
      if (hasNumericValue(movement?.grossAmount)) return grossAmount;
      return amount;
    default:
      return 0;
  }
};

export const calculateCashMovementSummary = (cashMovements = []) =>
  cashMovements.reduce(
    (summary, movement) => {
      const impact = getCashMovementImpact(movement);
      const withholdingTax = toNumber(movement.withholdingTax);

      summary.cashMovementsTotal += impact;
      if (movement.type === 'dividend') {
        summary.dividendNetReceived += impact;
        summary.dividendWithholdingTax += withholdingTax;
      }
      if (movement.type === 'withholding_tax') {
        summary.dividendWithholdingTax += toNumber(movement.amount);
      }
      if (movement.type === 'fee') {
        summary.fees += toNumber(movement.amount);
      }
      return summary;
    },
    {
      cashMovementsTotal: 0,
      dividendNetReceived: 0,
      dividendWithholdingTax: 0,
      fees: 0,
    },
  );

export const calculateStockTradeCashImpactTotal = (stockTrades = []) =>
  stockTrades.reduce((total, trade) => total + getStockTradeCashImpact(trade), 0);

export const calculatePortfolioCashSummary = (cashMovements = [], stockTrades = []) => {
  const cashSummary = calculateCashMovementSummary(cashMovements);
  const stockTradeCashImpact = calculateStockTradeCashImpactTotal(stockTrades);

  return {
    ...cashSummary,
    stockTradeCashImpact,
    calculatedCashBalance: cashSummary.cashMovementsTotal + stockTradeCashImpact,
  };
};
