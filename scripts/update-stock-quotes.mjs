import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YahooFinance from 'yahoo-finance2';
import { calculateStockPositions } from '../src/features/stocks/stockCalculations.js';

export const QUOTE_CACHE_PROVIDER = 'yahoo_finance2';
export const QUOTE_CACHE_SOURCE = 'yahoo_finance2_quote_cache';
export const QUOTE_CACHE_TYPE = 'delayed_or_regular_market';
export const MAX_QUOTE_CACHE_SYMBOLS = 50;
export const SYMBOL_PATTERN = /^[A-Z0-9.-]+$/;
export const FIRESTORE_DISCOVERY_SOURCE = 'firestore_stock_trades';
export const STATIC_SYMBOLS_SOURCE = 'static_symbols_json';

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

export const buildQuoteCachePayload = ({ quotes = [], errors = [], updatedAt = new Date().toISOString() } = {}) => ({
  provider: QUOTE_CACHE_PROVIDER,
  quoteType: QUOTE_CACHE_TYPE,
  updatedAt,
  quotes,
  errors,
});

export const loadQuoteSymbols = async (filePath = symbolsPath) => {
  const raw = await fs.readFile(filePath, 'utf8');
  const payload = JSON.parse(raw);
  return validateQuoteSymbols(payload.symbols);
};

export const deriveActiveSymbolsFromStockTrades = (trades = [], maxSymbols = MAX_QUOTE_CACHE_SYMBOLS) => {
  const activeSymbols = calculateStockPositions(trades)
    .filter((position) => Number(position.quantity) > 0)
    .map((position) => position.symbol);
  return validateQuoteSymbols(activeSymbols, maxSymbols);
};

export const parseFirebaseServiceAccount = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    try {
      return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must be JSON or base64-encoded JSON');
    }
  }
};

export const createFirestoreClientFromEnv = async (env = process.env) => {
  const serviceAccount = parseFirebaseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  const quoteUserId = String(env.QUOTE_USER_ID || '').trim();
  if (!serviceAccount || !quoteUserId) return null;

  const { cert, getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = getApps().length
    ? getApps()[0]
    : initializeApp({
      credential: cert(serviceAccount),
      projectId: env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
    });

  return getFirestore(app);
};

export const discoverFirestoreQuoteSymbols = async (db, userId, options = {}) => {
  if (!db) return { symbols: [], errors: [] };
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return { symbols: [], errors: [{ symbol: '', error: 'QUOTE_USER_ID is required for Firestore symbol discovery' }] };
  const maxSymbols = options.maxSymbols ?? MAX_QUOTE_CACHE_SYMBOLS;

  const snapshot = await db.collection('users').doc(normalizedUserId).collection('stockTrades').get();
  const trades = snapshot.docs.map((docSnap) => docSnap.data());
  const validated = deriveActiveSymbolsFromStockTrades(trades, maxSymbols);
  return {
    symbols: validated.symbols,
    errors: validated.errors.map((error) => ({ ...error, source: FIRESTORE_DISCOVERY_SOURCE })),
  };
};

export const loadQuoteSymbolsFromSource = async ({
  inputPath = symbolsPath,
  db = null,
  quoteUserId = '',
  maxSymbols = MAX_QUOTE_CACHE_SYMBOLS,
} = {}) => {
  if (db && quoteUserId) {
    const discovered = await discoverFirestoreQuoteSymbols(db, quoteUserId, { maxSymbols });
    return {
      symbols: discovered.symbols,
      errors: discovered.errors,
      warnings: discovered.symbols.length === 0 ? [{ message: 'No active stock holdings found from Firestore stockTrades' }] : [],
      symbolsSource: FIRESTORE_DISCOVERY_SOURCE,
    };
  }

  const configured = await loadQuoteSymbols(inputPath);
  const validated = validateQuoteSymbols(configured.symbols, maxSymbols);
  return {
    symbols: validated.symbols,
    errors: [...configured.errors, ...validated.errors],
    warnings: validated.symbols.length === 0 ? [{ message: 'No symbols configured in public/stock-quotes/symbols.json' }] : [],
    symbolsSource: STATIC_SYMBOLS_SOURCE,
  };
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
  db = null,
  env = process.env,
  now = new Date(),
} = {}) => {
  const firestoreDb = db || await createFirestoreClientFromEnv(env);
  const quoteUserId = String(env.QUOTE_USER_ID || '').trim();
  const { symbols, errors, warnings, symbolsSource } = await loadQuoteSymbolsFromSource({
    inputPath,
    db: firestoreDb,
    quoteUserId,
  });
  const quotes = [];
  const quoteErrors = [...errors];

  for (const symbol of symbols) {
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
    updatedAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
  });
  payload.symbolsSource = symbolsSource;
  payload.warnings = warnings;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const payload = await updateStockQuoteCache();
  console.log(`stock quote cache: ${payload.quotes.length} quotes, ${payload.errors.length} errors`);
}
