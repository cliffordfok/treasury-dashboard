import { normalizeStockQuote, STOCK_QUOTE_TYPE } from './stockPriceCalculations.js';

export const STOCK_QUOTE_CACHE_PROVIDER = 'yahoo_finance2';
export const STOCK_QUOTE_CACHE_SOURCE = 'yahoo_finance2_quote_cache';
export const STOCK_QUOTE_CACHE_STALE_HOURS = 24;
export const STOCK_QUOTE_CACHE_PATH = 'stock-quotes/latest.json';

const SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;
const MAX_SYMBOLS = 25;

const normalizeSymbol = (symbol) => String(symbol || '').trim().toUpperCase();

const getTimestampMillis = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value > 100000000000 ? value : value * 1000;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
};

export const normalizeQuoteCacheSymbols = (symbols = [], maxSymbols = MAX_SYMBOLS) => {
  const normalized = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
  if (normalized.length === 0) throw new Error('Please provide at least one stock symbol.');
  if (normalized.length > maxSymbols) throw new Error(`Quote cache refresh supports up to ${maxSymbols} symbols.`);
  const invalid = normalized.find((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (invalid) throw new Error(`Invalid stock symbol: ${invalid}`);
  return normalized;
};

export const getStockQuoteCacheUrl = (baseUrl = import.meta.env?.BASE_URL || '/') => {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${STOCK_QUOTE_CACHE_PATH}`;
};

export const buildStockQuoteCacheRequestUrl = (cacheUrl, cacheBust = Date.now()) => {
  if (cacheBust === false || cacheBust === null || cacheBust === undefined) return cacheUrl;
  const separator = String(cacheUrl).includes('?') ? '&' : '?';
  return `${cacheUrl}${separator}_ts=${encodeURIComponent(String(cacheBust))}`;
};

export const isQuoteCacheStale = (updatedAt, staleHours = STOCK_QUOTE_CACHE_STALE_HOURS, now = new Date()) => {
  const updatedMillis = getTimestampMillis(updatedAt);
  const nowMillis = getTimestampMillis(now);
  if (!updatedMillis || !nowMillis) return true;
  return nowMillis - updatedMillis > staleHours * 60 * 60 * 1000;
};

export const normalizeStockQuoteCache = (payload = {}, requestedSymbols = [], options = {}) => {
  const requested = requestedSymbols.map(normalizeSymbol).filter(Boolean);
  const staleHours = options.staleHours ?? STOCK_QUOTE_CACHE_STALE_HOURS;
  const now = options.now || new Date();
  const requestedSet = new Set(requested);
  const quoteRows = Array.isArray(payload.quotes) ? payload.quotes : [];
  const errors = Array.isArray(payload.errors)
    ? payload.errors.map((item) => ({
      symbol: normalizeSymbol(item.symbol),
      error: item.error || 'No quote returned',
    }))
    : [];
  const quotedSymbols = new Set();
  const erroredSymbols = new Set(errors.map((error) => error.symbol).filter(Boolean));
  const quotes = [];

  quoteRows.forEach((row) => {
    const symbol = normalizeSymbol(row?.symbol);
    if (requested.length > 0 && !requestedSet.has(symbol)) return;
    const quote = normalizeStockQuote({
      ...row,
      source: row.source || STOCK_QUOTE_CACHE_SOURCE,
      quoteType: row.quoteType || STOCK_QUOTE_TYPE,
    });
    if (quote) {
      quotes.push(quote);
      quotedSymbols.add(quote.symbol);
    } else if (symbol) {
      errors.push({ symbol, error: 'Invalid cached quote price' });
      erroredSymbols.add(symbol);
    }
  });

  requested.forEach((symbol) => {
    if (!quotedSymbols.has(symbol) && !erroredSymbols.has(symbol)) {
      errors.push({ symbol, error: '報價快取未包含此股票；請先加入 public/stock-quotes/symbols.json，然後執行 Update Stock Quotes workflow' });
    }
  });

  const isStale = isQuoteCacheStale(payload.updatedAt, staleHours, now);
  const warnings = isStale ? ['報價快取可能已過期'] : [];

  return {
    provider: payload.provider || STOCK_QUOTE_CACHE_PROVIDER,
    quoteType: payload.quoteType || STOCK_QUOTE_TYPE,
    updatedAt: payload.updatedAt || null,
    quotes,
    errors,
    warnings,
    isStale,
  };
};

export const fetchStockQuoteCache = async (symbols = [], options = {}) => {
  const normalizedSymbols = normalizeQuoteCacheSymbols(symbols);
  const fetchImpl = options.fetchImpl || fetch;
  const cacheUrl = options.cacheUrl || getStockQuoteCacheUrl(options.baseUrl);
  const requestUrl = buildStockQuoteCacheRequestUrl(cacheUrl, options.cacheBust ?? Date.now());

  let response;
  try {
    response = await fetchImpl(requestUrl, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw new Error(`Unable to load stock quote cache from ${cacheUrl}. ${error?.message || ''}`.trim());
  }

  if (!response.ok) {
    throw new Error(`Unable to load stock quote cache from ${cacheUrl}. HTTP ${response.status}`);
  }

  const payload = await response.json();
  return normalizeStockQuoteCache(payload, normalizedSymbols, options);
};
