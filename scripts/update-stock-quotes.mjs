import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YahooFinance from 'yahoo-finance2';

export const QUOTE_CACHE_PROVIDER = 'yahoo_finance2';
export const QUOTE_CACHE_SOURCE = 'yahoo_finance2_quote_cache';
export const QUOTE_CACHE_TYPE = 'delayed_or_regular_market';
export const STATIC_SYMBOLS_SOURCE = 'static_symbols_json';
export const MAX_QUOTE_CACHE_SYMBOLS = 50;
export const SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const symbolsPath = path.join(repoRoot, 'public', 'stock-quotes', 'symbols.json');
const latestPath = path.join(repoRoot, 'public', 'stock-quotes', 'latest.json');
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toIsoDate = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 100000000000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

export const validateQuoteSymbols = (symbols = [], maxSymbols = MAX_QUOTE_CACHE_SYMBOLS) => {
  if (!Array.isArray(symbols)) {
    return { symbols: [], errors: [{ symbol: '', error: 'symbols must be an array' }] };
  }

  const errors = [];
  const seen = new Set();
  const normalized = [];

  symbols.forEach((value) => {
    const symbol = String(value || '').trim().toUpperCase();
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    if (!SYMBOL_PATTERN.test(symbol)) {
      errors.push({ symbol, error: 'Invalid symbol' });
      return;
    }
    normalized.push(symbol);
  });

  if (normalized.length > maxSymbols) {
    errors.push({ symbol: '', error: `Maximum ${maxSymbols} symbols are supported` });
    return { symbols: normalized.slice(0, maxSymbols), errors };
  }

  return { symbols: normalized, errors };
};

export const normalizeYahooFinance2Quote = (quote = {}) => {
  const symbol = String(quote.symbol || '').trim().toUpperCase();
  const price = toNumberOrNull(quote.regularMarketPrice ?? quote.price);
  if (!symbol || price == null || price <= 0) return null;

  return {
    symbol,
    price,
    currency: String(quote.currency || 'USD').trim().toUpperCase() || 'USD',
    asOf: toIsoDate(quote.regularMarketTime ?? quote.asOf) || new Date().toISOString(),
    previousClose: toNumberOrNull(quote.regularMarketPreviousClose ?? quote.previousClose),
    change: toNumberOrNull(quote.regularMarketChange ?? quote.change),
    changePercent: toNumberOrNull(quote.regularMarketChangePercent ?? quote.changePercent),
    source: QUOTE_CACHE_SOURCE,
    quoteType: QUOTE_CACHE_TYPE,
  };
};

export const buildQuoteCachePayload = ({
  quotes = [],
  errors = [],
  warnings = [],
  updatedAt = new Date().toISOString(),
  symbolsSource = STATIC_SYMBOLS_SOURCE,
} = {}) => ({
  provider: QUOTE_CACHE_PROVIDER,
  quoteType: QUOTE_CACHE_TYPE,
  updatedAt,
  symbolsSource,
  quotes,
  errors,
  warnings,
});

export const loadQuoteSymbols = async (filePath = symbolsPath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  const payload = JSON.parse(raw);
  return validateQuoteSymbols(payload.symbols);
};

export const fetchQuoteForSymbol = async (symbol, quoteClient = yahooFinance) => {
  const response = await quoteClient.quote(symbol);
  const quote = normalizeYahooFinance2Quote(response);
  if (!quote) return { quote: null, error: { symbol, error: 'No valid price returned' } };
  return { quote, error: null };
};

export const updateStockQuoteCache = async ({
  inputPath = symbolsPath,
  outputPath = latestPath,
  quoteClient = yahooFinance,
  now = new Date(),
} = {}) => {
  const configured = await loadQuoteSymbols(inputPath);
  const quotes = [];
  const quoteErrors = [...configured.errors];
  const warnings = configured.symbols.length === 0
    ? [{ message: 'No symbols configured in public/stock-quotes/symbols.json' }]
    : [];

  for (const symbol of configured.symbols) {
    try {
      const { quote, error } = await fetchQuoteForSymbol(symbol, quoteClient);
      if (quote) quotes.push(quote);
      if (error) quoteErrors.push(error);
    } catch (error) {
      quoteErrors.push({ symbol, error: error?.message || 'Quote request failed' });
    }
  }

  const payload = buildQuoteCachePayload({
    quotes,
    errors: quoteErrors,
    warnings,
    updatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
    symbolsSource: STATIC_SYMBOLS_SOURCE,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const payload = await updateStockQuoteCache();
  console.log(`stock quote cache: ${payload.quotes.length} quotes, ${payload.errors.length} errors`);
}
