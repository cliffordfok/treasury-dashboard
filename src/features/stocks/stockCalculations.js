export const EPSILON = 0.0000001;

export const toNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export const normalizeSymbol = (symbol) => String(symbol || '').trim().toUpperCase();

export const getStockTradeCashImpact = (trade) => {
  const quantity = toNumber(trade.quantity);
  const price = toNumber(trade.price);
  const commission = toNumber(trade.commission);
  const fees = toNumber(trade.fees);
  const gross = quantity * price;
  const costs = commission + fees;

  if (trade.side === 'sell') return gross - costs;
  return -(gross + costs);
};

const sortTradesChronologically = (trades) =>
  [...trades].sort((a, b) => {
    const aKey = `${a.tradeDate || ''}T${a.tradeTime || '00:00'}:${a.createdAt || ''}`;
    const bKey = `${b.tradeDate || ''}T${b.tradeTime || '00:00'}:${b.createdAt || ''}`;
    return aKey.localeCompare(bKey);
  });

const createEmptyPosition = (symbol, trade = {}) => ({
  symbol,
  name: trade.name || '',
  currency: trade.currency || 'USD',
  quantity: 0,
  totalBuyCost: 0,
  averageCost: 0,
  remainingCost: 0,
  realizedPnl: 0,
  totalFees: 0,
  cashImpact: 0,
  tradeCount: 0,
});

export const calculateStockPositions = (trades = []) => {
  const positions = new Map();

  sortTradesChronologically(trades).forEach((trade) => {
    const symbol = normalizeSymbol(trade.symbol);
    if (!symbol) return;

    const quantity = toNumber(trade.quantity);
    const price = toNumber(trade.price);
    const commission = toNumber(trade.commission);
    const fees = toNumber(trade.fees);
    if (quantity <= 0 || price < 0) return;

    const position = positions.get(symbol) || createEmptyPosition(symbol, trade);
    const costs = commission + fees;
    const gross = quantity * price;

    position.name = position.name || trade.name || '';
    position.currency = trade.currency || position.currency || 'USD';
    position.totalFees += costs;
    position.tradeCount += 1;

    if (trade.side === 'sell') {
      const avgCostBeforeSell = position.quantity > EPSILON ? position.remainingCost / position.quantity : 0;
      const costRemoved = avgCostBeforeSell * quantity;
      const netProceeds = gross - costs;

      position.quantity -= quantity;
      position.realizedPnl += netProceeds - costRemoved;
      position.remainingCost = position.quantity > EPSILON ? Math.max(0, position.remainingCost - costRemoved) : 0;
      position.cashImpact += netProceeds;
    } else {
      const buyCost = gross + costs;
      position.quantity += quantity;
      position.totalBuyCost += buyCost;
      position.remainingCost += buyCost;
      position.cashImpact -= buyCost;
    }

    position.averageCost = Math.abs(position.quantity) > EPSILON ? position.remainingCost / position.quantity : 0;
    positions.set(symbol, position);
  });

  return Array.from(positions.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
};

export const calculateStockPortfolioTotals = (positions = []) =>
  positions.reduce(
    (totals, position) => ({
      quantity: totals.quantity + position.quantity,
      remainingCost: totals.remainingCost + position.remainingCost,
      totalBuyCost: totals.totalBuyCost + position.totalBuyCost,
      realizedPnl: totals.realizedPnl + position.realizedPnl,
      totalFees: totals.totalFees + position.totalFees,
      cashImpact: totals.cashImpact + position.cashImpact,
    }),
    {
      quantity: 0,
      remainingCost: 0,
      totalBuyCost: 0,
      realizedPnl: 0,
      totalFees: 0,
      cashImpact: 0,
    },
  );
