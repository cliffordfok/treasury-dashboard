export const AUTO_QUOTE_STALE_HOURS = 12;
export const AUTO_QUOTE_ATTEMPT_COOLDOWN_MINUTES = 15;
export const AUTO_QUOTE_ENABLED_KEY = 'portfolio:autoQuote:enabled';
export const AUTO_QUOTE_LAST_ATTEMPT_PREFIX = 'portfolio:autoQuote:lastAttempt';
export const AUTO_QUOTE_MAX_SYMBOLS = 25;

const SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;
let autoQuoteRefreshInFlight = false;

const normalizeSymbol = (symbol) => String(symbol || '').trim().toUpperCase();

export const getAutoQuoteLastAttemptKey = (uid) => `${AUTO_QUOTE_LAST_ATTEMPT_PREFIX}:${uid || 'anonymous'}`;

export const getTimestampMillis = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value > 100000000000 ? value : value * 1000;
  if (typeof value === 'object' && typeof value.toDate === 'function') {
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  }
  if (typeof value === 'object' && Number.isFinite(value.seconds)) return value.seconds * 1000;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
};

const getPriceTimestamp = (price = {}) =>
  getTimestampMillis(price.updatedAt) ?? getTimestampMillis(price.asOf);

export const isQuoteStale = (price = {}, staleHours = AUTO_QUOTE_STALE_HOURS, now = new Date()) => {
  const timestamp = getPriceTimestamp(price);
  const nowMillis = getTimestampMillis(now);
  if (!timestamp || !nowMillis) return true;
  return nowMillis - timestamp > staleHours * 60 * 60 * 1000;
};

export const getSymbolsNeedingRefresh = (positions = [], priceMap = {}, options = {}) => {
  const staleHours = options.staleHours ?? AUTO_QUOTE_STALE_HOURS;
  const now = options.now || new Date();
  const maxSymbols = options.maxSymbols ?? AUTO_QUOTE_MAX_SYMBOLS;
  const symbols = [];
  const seen = new Set();

  positions.forEach((position) => {
    const symbol = normalizeSymbol(position.symbol);
    const quantity = Number(position.quantity);
    if (!symbol || !SYMBOL_PATTERN.test(symbol) || !Number.isFinite(quantity) || quantity <= 0 || seen.has(symbol)) return;
    const price = priceMap instanceof Map ? priceMap.get(symbol) : priceMap?.[symbol];
    if (!price || isQuoteStale(price, staleHours, now)) {
      symbols.push(symbol);
      seen.add(symbol);
    }
  });

  return symbols.slice(0, maxSymbols);
};

export const shouldAttemptAutoRefresh = (
  lastAttempt,
  cooldownMinutes = AUTO_QUOTE_ATTEMPT_COOLDOWN_MINUTES,
  now = new Date(),
  mode = 'auto',
) => {
  if (mode !== 'auto') return true;
  const lastAttemptMillis = getTimestampMillis(lastAttempt);
  const nowMillis = getTimestampMillis(now);
  if (!lastAttemptMillis || !nowMillis) return true;
  return nowMillis - lastAttemptMillis >= cooldownMinutes * 60 * 1000;
};

export const shouldPreserveManualPrice = (existingPrice = {}, incomingQuote = {}, mode = 'auto') => {
  if (mode !== 'auto') return false;
  if (existingPrice.source !== 'manual') return false;
  const existingMillis = getPriceTimestamp(existingPrice);
  const incomingMillis = getPriceTimestamp(incomingQuote);
  if (!existingMillis || !incomingMillis) return false;
  return existingMillis > incomingMillis;
};

export const filterQuotesForSave = (quotes = [], priceMap = {}, mode = 'auto') =>
  quotes.filter((quote) => {
    const symbol = normalizeSymbol(quote.symbol);
    const existing = priceMap instanceof Map ? priceMap.get(symbol) : priceMap?.[symbol];
    return !shouldPreserveManualPrice(existing, quote, mode);
  });

export const beginAutoQuoteRefresh = () => {
  if (autoQuoteRefreshInFlight) return false;
  autoQuoteRefreshInFlight = true;
  return true;
};

export const endAutoQuoteRefresh = () => {
  autoQuoteRefreshInFlight = false;
};
