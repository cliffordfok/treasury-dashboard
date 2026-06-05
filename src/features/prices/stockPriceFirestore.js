import { collection, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { normalizeStockQuote, STOCK_QUOTE_TYPE } from './stockPriceCalculations.js';

const normalizeSymbol = (symbol) => String(symbol || '').trim().toUpperCase();

const normalizePriceForStorage = (quote = {}, sourceOverride = '') => {
  const normalized = normalizeStockQuote({
    ...quote,
    source: sourceOverride || quote.source,
    quoteType: quote.quoteType || (sourceOverride === 'manual' ? 'manual' : STOCK_QUOTE_TYPE),
  });
  if (!normalized) return null;
  return {
    ...normalized,
    updatedAt: serverTimestamp(),
  };
};

export const subscribeStockPrices = (db, userId, onPrices, onError) => {
  const pricesRef = collection(db, 'users', userId, 'stockPrices');
  return onSnapshot(
    pricesRef,
    (snapshot) => {
      onPrices(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
    },
    onError,
  );
};

export const saveStockPrices = async (db, userId, quotes = []) => {
  const writes = quotes
    .map((quote) => normalizePriceForStorage(quote))
    .filter(Boolean)
    .map((quote) => setDoc(doc(db, 'users', userId, 'stockPrices', quote.symbol), quote, { merge: true }));
  await Promise.all(writes);
};

export const saveManualStockPrice = async (db, userId, quote = {}) => {
  const normalized = normalizePriceForStorage(
    {
      ...quote,
      symbol: normalizeSymbol(quote.symbol),
      source: 'manual',
      quoteType: 'manual',
    },
    'manual',
  );
  if (!normalized) throw new Error('Please enter a valid stock symbol and price.');
  await setDoc(doc(db, 'users', userId, 'stockPrices', normalized.symbol), normalized, { merge: true });
};

export const getStockPriceMap = (prices = []) =>
  prices.reduce((map, price) => {
    const symbol = normalizeSymbol(price.symbol || price.id);
    if (symbol) map[symbol] = { ...price, symbol };
    return map;
  }, {});

