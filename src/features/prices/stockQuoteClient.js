import { normalizeStockQuote, STOCK_QUOTE_PROVIDER, STOCK_QUOTE_TYPE } from './stockPriceCalculations.js';

const SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;
const MAX_SYMBOLS = 25;

const getProxyUrl = () => import.meta.env?.VITE_STOCK_QUOTE_PROXY_URL || '';

export const normalizeQuoteSymbols = (symbols = []) => {
  const normalized = [...new Set(symbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) throw new Error('Please provide at least one stock symbol.');
  if (normalized.length > MAX_SYMBOLS) throw new Error(`Quote request supports up to ${MAX_SYMBOLS} symbols.`);

  const invalid = normalized.find((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (invalid) throw new Error(`Invalid stock symbol: ${invalid}`);
  return normalized;
};

export const normalizeStockQuoteProxyResponse = (payload = {}, requestedSymbols = []) => {
  const requested = requestedSymbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean);
  const quoteRows = Array.isArray(payload.quotes) ? payload.quotes : [];
  const quotes = quoteRows.map(normalizeStockQuote).filter(Boolean);
  const errors = Array.isArray(payload.errors) ? payload.errors.map((item) => ({
    symbol: String(item.symbol || '').trim().toUpperCase(),
    error: item.error || 'No quote returned',
  })) : [];
  const quotedSymbols = new Set(quotes.map((quote) => quote.symbol));
  const erroredSymbols = new Set(errors.map((error) => error.symbol));

  requested.forEach((symbol) => {
    if (!quotedSymbols.has(symbol) && !erroredSymbols.has(symbol)) {
      errors.push({ symbol, error: 'No quote returned' });
    }
  });

  return {
    provider: payload.provider || STOCK_QUOTE_PROVIDER,
    quoteType: payload.quoteType || STOCK_QUOTE_TYPE,
    quotes,
    errors,
  };
};

export const fetchStockQuotes = async (symbols = [], options = {}) => {
  const normalizedSymbols = normalizeQuoteSymbols(symbols);
  const proxyUrl = options.proxyUrl ?? getProxyUrl();
  if (!proxyUrl) {
    throw new Error('Please configure the stock quote Proxy URL (VITE_STOCK_QUOTE_PROXY_URL).');
  }
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbols: normalizedSymbols }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Stock quote proxy error: HTTP ${response.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
  }

  const payload = await response.json();
  return normalizeStockQuoteProxyResponse(payload, normalizedSymbols);
};

