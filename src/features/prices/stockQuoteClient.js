import { parseTwelveDataQuoteResponse, STOCK_QUOTE_PROVIDER, STOCK_QUOTE_TYPE } from './stockPriceCalculations.js';

const SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;
const MAX_SYMBOLS = 25;

export const TWELVE_DATA_API_URL = 'https://api.twelvedata.com/quote';

export const buildTwelveDataErrorMessage = ({ status, detail } = {}) => {
  const statusText = status ? `HTTP ${status}` : 'network error';
  const detailText = detail ? ` ${detail}` : '';
  return `Twelve Data 報價失敗（${statusText}）。${detailText}`.trim();
};

export const normalizeQuoteSymbols = (symbols = []) => {
  const normalized = [...new Set(symbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) throw new Error('請提供至少一個股票代號。');
  if (normalized.length > MAX_SYMBOLS) throw new Error(`每次最多可更新 ${MAX_SYMBOLS} 個股票代號。`);

  const invalid = normalized.find((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (invalid) throw new Error(`股票代號格式不正確：${invalid}`);
  return normalized;
};

export const buildTwelveDataQuoteUrl = (symbols = [], apiKey = '', endpoint = TWELVE_DATA_API_URL) => {
  const key = String(apiKey || '').trim();
  if (!key) throw new Error('請先輸入 Twelve Data API Key。');
  const normalizedSymbols = normalizeQuoteSymbols(symbols);
  const url = new URL(endpoint);
  url.searchParams.set('symbol', normalizedSymbols.join(','));
  url.searchParams.set('apikey', key);
  return url.toString();
};

export const normalizeStockQuoteProxyResponse = (payload = {}, requestedSymbols = []) => {
  const parsed = parseTwelveDataQuoteResponse(payload, requestedSymbols);
  return {
    provider: parsed.provider || STOCK_QUOTE_PROVIDER,
    quoteType: parsed.quoteType || STOCK_QUOTE_TYPE,
    quotes: parsed.quotes,
    errors: parsed.errors,
  };
};

export const fetchStockQuotes = async (symbols = [], options = {}) => {
  const normalizedSymbols = normalizeQuoteSymbols(symbols);
  const fetchImpl = options.fetchImpl || fetch;
  const apiKey = options.apiKey || '';
  const endpoint = options.endpoint || TWELVE_DATA_API_URL;
  const requestUrl = buildTwelveDataQuoteUrl(normalizedSymbols, apiKey, endpoint);

  let response;
  try {
    response = await fetchImpl(requestUrl, { method: 'GET' });
  } catch (error) {
    throw new Error(buildTwelveDataErrorMessage({ detail: error?.message ? `(${error.message})` : '' }));
  }

  if (!response.ok) throw new Error(buildTwelveDataErrorMessage({ status: response.status }));

  const payload = await response.json();
  return normalizeStockQuoteProxyResponse(payload, normalizedSymbols);
};
