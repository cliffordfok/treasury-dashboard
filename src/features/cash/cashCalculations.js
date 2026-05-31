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
  opening_balance: '期初現金',
  deposit: '入金',
  withdrawal: '出金',
  dividend: '股息',
  interest: '利息',
  fee: '費用',
  withholding_tax: '預扣稅',
  adjustment: '手動調整',
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
