import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { normalizeSymbol, toNumber } from './stockCalculations';

const makeStockTradeId = () => `stock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const defaultStockTradeForm = () => ({
  accountId: 'firstrade',
  symbol: '',
  name: '',
  side: 'buy',
  tradeDate: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0],
  tradeTime: '',
  quantity: '',
  price: '',
  commission: 0,
  fees: 0,
  currency: 'USD',
  notes: '',
});

export const normalizeStockTradeForStorage = (trade, userId, existingTrade = null) => {
  const now = new Date().toISOString();
  const id = String(trade.id || existingTrade?.id || makeStockTradeId());
  const side = ['buy', 'sell', 'opening_position'].includes(trade.side) ? trade.side : 'buy';

  return {
    id,
    userId,
    accountId: String(trade.accountId || existingTrade?.accountId || 'firstrade').trim() || 'firstrade',
    symbol: normalizeSymbol(trade.symbol),
    name: String(trade.name || '').trim(),
    side,
    tradeDate: trade.tradeDate,
    tradeTime: String(trade.tradeTime || '').trim(),
    quantity: toNumber(trade.quantity),
    price: toNumber(trade.price),
    commission: toNumber(trade.commission),
    fees: toNumber(trade.fees),
    currency: String(trade.currency || 'USD').trim().toUpperCase() || 'USD',
    notes: String(trade.notes || '').trim(),
    source: String(trade.source || existingTrade?.source || '').trim(),
    importFingerprint: String(trade.importFingerprint || existingTrade?.importFingerprint || '').trim(),
    createdAt: existingTrade?.createdAt || trade.createdAt || now,
    updatedAt: now,
  };
};

export const subscribeStockTrades = (db, userId, onTrades, onError) => {
  const tradesRef = collection(db, 'users', userId, 'stockTrades');
  return onSnapshot(
    tradesRef,
    (snapshot) => {
      const trades = snapshot.docs
        .map((item) => item.data())
        .sort((a, b) => {
          const aKey = `${a.tradeDate || ''}T${a.tradeTime || '00:00'}:${a.createdAt || ''}`;
          const bKey = `${b.tradeDate || ''}T${b.tradeTime || '00:00'}:${b.createdAt || ''}`;
          return bKey.localeCompare(aKey);
        });
      onTrades(trades);
    },
    onError,
  );
};

export const saveStockTrade = async (db, userId, trade) => {
  const tradeRef = doc(db, 'users', userId, 'stockTrades', trade.id);
  await setDoc(tradeRef, trade);
};

export const deleteStockTrade = async (db, userId, tradeId) => {
  await deleteDoc(doc(db, 'users', userId, 'stockTrades', tradeId));
};
