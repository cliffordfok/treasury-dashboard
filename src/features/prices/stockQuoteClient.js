import { normalizeStockQuote, STOCK_QUOTE_PROVIDER, STOCK_QUOTE_TYPE } from './stockPriceCalculations.js';

const SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;
const MAX_SYMBOLS = 25;
export const DEFAULT_STOCK_QUOTE_PROXY_URL = '/api/stock-quotes';
export const STOCK_QUOTE_PROXY_UNAVAILABLE_MESSAGE =
  '股票報價 Proxy 未可用。如使用 Vercel，請確認 api/stock-quotes.js 已部署；如使用 GitHub Pages，請部署 Cloudflare Worker / Firebase / Netlify server-side proxy，並設定 VITE_STOCK_QUOTE_PROXY_URL 或 VITE_AI_PROXY_URL 指向該 proxy。';

export const resolveStockQuoteProxyUrl = (env = {}) =>
  env.VITE_STOCK_QUOTE_PROXY_URL || env.VITE_AI_PROXY_URL || env.VITE_GEMINI_PROXY_URL || DEFAULT_STOCK_QUOTE_PROXY_URL;

export const getStockQuoteProxyUrl = () => resolveStockQuoteProxyUrl(import.meta.env);

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
  const proxyUrl = options.proxyUrl || getStockQuoteProxyUrl();
  const fetchImpl = options.fetchImpl || fetch;

  let response;
  try {
    response = await fetchImpl(proxyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: normalizedSymbols }),
    });
  } catch (error) {
    throw new Error(`${STOCK_QUOTE_PROXY_UNAVAILABLE_MESSAGE}${error?.message ? ` (${error.message})` : ''}`);
  }

  if (!response.ok) throw new Error(`${STOCK_QUOTE_PROXY_UNAVAILABLE_MESSAGE} (HTTP ${response.status})`);

  const payload = await response.json();
  return normalizeStockQuoteProxyResponse(payload, normalizedSymbols);
};
