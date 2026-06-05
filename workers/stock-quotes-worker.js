const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const PROVIDER = 'yahoo_finance_unofficial';
const QUOTE_TYPE = 'delayed_or_regular_market';
const SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;
const MAX_SYMBOLS = 25;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const HEALTH_PAYLOAD = {
  ok: true,
  message: 'Stock quote proxy is available. Use POST with symbols.',
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });

export const normalizeStockSymbols = (symbols = []) => {
  if (!Array.isArray(symbols)) throw new Error('symbols must be an array');
  const normalized = [...new Set(symbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) throw new Error('At least one symbol is required');
  if (normalized.length > MAX_SYMBOLS) throw new Error(`Maximum ${MAX_SYMBOLS} symbols per request`);
  const invalid = normalized.find((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (invalid) throw new Error(`Invalid symbol: ${invalid}`);
  return normalized;
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

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

export const parseYahooQuotePayload = (payload = {}, requestedSymbols = []) => {
  const rows = Array.isArray(payload?.quoteResponse?.result) ? payload.quoteResponse.result : [];
  const requested = requestedSymbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean);
  const quotes = [];
  const errors = [];
  const seen = new Set();

  rows.forEach((row) => {
    const symbol = String(row?.symbol || '').trim().toUpperCase();
    if (!symbol) return;
    seen.add(symbol);
    const price = toNumberOrNull(row.regularMarketPrice);
    if (!price || price <= 0) {
      errors.push({ symbol, error: 'No quote returned' });
      return;
    }
    quotes.push({
      symbol,
      price,
      currency: String(row.currency || 'USD').trim().toUpperCase() || 'USD',
      asOf: toIsoDate(row.regularMarketTime) || new Date().toISOString(),
      previousClose: toNumberOrNull(row.regularMarketPreviousClose),
      change: toNumberOrNull(row.regularMarketChange),
      changePercent: toNumberOrNull(row.regularMarketChangePercent),
      source: PROVIDER,
      quoteType: QUOTE_TYPE,
    });
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

export const fetchYahooQuotes = async (symbols, fetchImpl = fetch) => {
  const normalizedSymbols = normalizeStockSymbols(symbols);
  const upstream = await fetchImpl(`${YAHOO_QUOTE_URL}?symbols=${encodeURIComponent(normalizedSymbols.join(','))}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 treasury-dashboard-stock-quote-proxy',
    },
  });

  if (!upstream.ok) {
    return {
      provider: PROVIDER,
      quoteType: QUOTE_TYPE,
      quotes: [],
      errors: normalizedSymbols.map((symbol) => ({ symbol, error: `Yahoo Finance HTTP ${upstream.status}` })),
    };
  }

  return parseYahooQuotePayload(await upstream.json(), normalizedSymbols);
};

export const handleStockQuoteRequest = async (request, fetchImpl = fetch) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method === 'GET') return jsonResponse(HEALTH_PAYLOAD);
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json();
    return jsonResponse(await fetchYahooQuotes(body.symbols, fetchImpl));
  } catch (error) {
    return jsonResponse({ error: error.message || 'Invalid request' }, 400);
  }
};

export default {
  fetch: handleStockQuoteRequest,
};

