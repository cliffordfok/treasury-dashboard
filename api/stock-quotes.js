import { parseYahooQuoteResponse } from '../src/features/prices/stockPriceCalculations.js';

const SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;
const MAX_SYMBOLS = 25;
const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const TIMEOUT_MS = 8000;

const normalizeSymbols = (symbols = []) => {
  if (!Array.isArray(symbols)) throw new Error('symbols must be an array');
  const normalized = [...new Set(symbols.map((symbol) => String(symbol || '').trim().toUpperCase()).filter(Boolean))];
  if (normalized.length === 0) throw new Error('At least one symbol is required');
  if (normalized.length > MAX_SYMBOLS) throw new Error(`Maximum ${MAX_SYMBOLS} symbols per request`);
  const invalid = normalized.find((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (invalid) throw new Error(`Invalid symbol: ${invalid}`);
  return normalized;
};

const readBody = async (req) => {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
};

const sendJson = (res, status, payload) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  let symbols;
  try {
    const body = await readBody(req);
    symbols = normalizeSymbols(body.symbols);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Invalid request' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `${YAHOO_QUOTE_URL}?symbols=${encodeURIComponent(symbols.join(','))}`;
    const yahooResponse = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 stock-quote-proxy',
      },
    });

    if (!yahooResponse.ok) {
      sendJson(res, 502, {
        provider: 'yahoo_finance_unofficial',
        quoteType: 'delayed_or_regular_market',
        quotes: [],
        errors: symbols.map((symbol) => ({ symbol, error: `Yahoo Finance HTTP ${yahooResponse.status}` })),
      });
      return;
    }

    const payload = await yahooResponse.json();
    sendJson(res, 200, parseYahooQuoteResponse(payload, symbols));
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'Yahoo Finance request timed out' : (error.message || 'Yahoo Finance request failed');
    sendJson(res, 200, {
      provider: 'yahoo_finance_unofficial',
      quoteType: 'delayed_or_regular_market',
      quotes: [],
      errors: symbols.map((symbol) => ({ symbol, error: message })),
    });
  } finally {
    clearTimeout(timeout);
  }
}

