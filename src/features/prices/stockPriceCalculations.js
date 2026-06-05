const PROVIDER = 'yahoo_finance_unofficial';
const QUOTE_TYPE = 'delayed_or_regular_market';
const STALE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const STOCK_QUOTE_PROVIDER = PROVIDER;
export const STOCK_QUOTE_TYPE = QUOTE_TYPE;

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizeSymbol = (symbol) => String(symbol || '').trim().toUpperCase();

const toIsoDate = (value) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 100000000000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

export const normalizeStockQuote = (quote = {}) => {
  const symbol = normalizeSymbol(quote.symbol);
  const price = toNumberOrNull(quote.price ?? quote.regularMarketPrice);
  if (!symbol || price == null || price <= 0) return null;

  return {
    symbol,
    price,
    currency: String(quote.currency || 'USD').trim().toUpperCase() || 'USD',
    asOf: toIsoDate(quote.asOf ?? quote.regularMarketTime) || new Date().toISOString(),
    previousClose: toNumberOrNull(quote.previousClose ?? quote.regularMarketPreviousClose),
    change: toNumberOrNull(quote.change ?? quote.regularMarketChange),
    changePercent: toNumberOrNull(quote.changePercent ?? quote.regularMarketChangePercent),
    source: quote.source || PROVIDER,
    quoteType: quote.quoteType || QUOTE_TYPE,
  };
};

export const parseYahooQuoteResponse = (response = {}, requestedSymbols = []) => {
  const requested = requestedSymbols.map(normalizeSymbol).filter(Boolean);
  const result = response?.quoteResponse?.result;
  const rows = Array.isArray(result) ? result : [];
  const quotes = [];
  const errors = [];
  const seen = new Set();

  rows.forEach((row) => {
    const symbol = normalizeSymbol(row?.symbol);
    if (!symbol) return;
    seen.add(symbol);
    const quote = normalizeStockQuote({
      symbol,
      price: row.regularMarketPrice,
      currency: row.currency,
      asOf: row.regularMarketTime,
      previousClose: row.regularMarketPreviousClose,
      change: row.regularMarketChange,
      changePercent: row.regularMarketChangePercent,
      source: PROVIDER,
      quoteType: QUOTE_TYPE,
    });
    if (quote) {
      quotes.push(quote);
    } else {
      errors.push({ symbol, error: 'No quote returned' });
    }
  });

  requested.forEach((symbol) => {
    if (!seen.has(symbol)) errors.push({ symbol, error: 'No quote returned' });
  });

  return {
    provider: PROVIDER,
    quoteType: QUOTE_TYPE,
    quotes,
    errors,
  };
};

export const isStockPriceStale = (price = {}, now = new Date()) => {
  const sourceDate = price.asOf || price.updatedAt;
  if (!sourceDate) return true;
  const asOf = new Date(sourceDate);
  const current = new Date(now);
  if (Number.isNaN(asOf.getTime()) || Number.isNaN(current.getTime())) return true;
  return current.getTime() - asOf.getTime() > STALE_DAYS * MS_PER_DAY;
};

export const attachPricesToPositions = (positions = [], priceMap = {}, now = new Date()) =>
  positions.map((position) => {
    const symbol = normalizeSymbol(position.symbol);
    const quote = priceMap instanceof Map ? priceMap.get(symbol) : priceMap?.[symbol];
    const price = toNumberOrNull(quote?.price);
    const quantity = toNumberOrNull(position.quantity) || 0;
    const remainingCost = toNumberOrNull(position.remainingCost) || 0;

    if (price == null || price <= 0) {
      return {
        ...position,
        currentPrice: null,
        priceAsOf: quote?.asOf || quote?.updatedAt || '',
        priceSource: quote?.source || '',
        marketValue: null,
        unrealizedPnl: null,
        unrealizedPnlPercent: null,
        isPriceStale: Boolean(quote) ? isStockPriceStale(quote, now) : false,
      };
    }

    const marketValue = quantity * price;
    const unrealizedPnl = marketValue - remainingCost;
    const unrealizedPnlPercent = remainingCost > 0 ? (unrealizedPnl / remainingCost) * 100 : null;

    return {
      ...position,
      currentPrice: price,
      priceAsOf: quote.asOf || quote.updatedAt || '',
      priceSource: quote.source || '',
      marketValue,
      unrealizedPnl,
      unrealizedPnlPercent,
      isPriceStale: isStockPriceStale(quote, now),
    };
  });

export const calculateStockMarketTotals = (positionsWithPrices = []) =>
  positionsWithPrices.reduce(
    (totals, position) => {
      const marketValue = toNumberOrNull(position.marketValue);
      const unrealizedPnl = toNumberOrNull(position.unrealizedPnl);
      const hasPrice = toNumberOrNull(position.currentPrice) != null && marketValue != null;

      return {
        totalMarketValue: totals.totalMarketValue + (marketValue || 0),
        totalUnrealizedPnl: totals.totalUnrealizedPnl + (unrealizedPnl || 0),
        pricedSymbolCount: totals.pricedSymbolCount + (hasPrice ? 1 : 0),
        missingPriceCount: totals.missingPriceCount + (hasPrice ? 0 : 1),
        stalePriceCount: totals.stalePriceCount + (position.isPriceStale ? 1 : 0),
      };
    },
    {
      totalMarketValue: 0,
      totalUnrealizedPnl: 0,
      pricedSymbolCount: 0,
      missingPriceCount: 0,
      stalePriceCount: 0,
    },
  );
