import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { normalizeSymbol, toNumber } from '../stocks/stockCalculations.js';

const makeReconciliationSnapshotId = () => `recon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0];

const optionalNumber = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  return toNumber(value);
};

export const defaultReconciliationSnapshotForm = () => ({
  accountId: 'firstrade',
  date: todayISO(),
  currency: 'USD',
  brokerCashBalance: '',
  brokerTotalMarketValue: '',
  brokerTotalAccountValue: '',
  notes: '',
  holdings: [],
});

export const defaultHoldingRow = () => ({
  symbol: '',
  brokerQuantity: '',
  brokerCostBasis: '',
  brokerMarketValue: '',
  notes: '',
});

export const normalizeReconciliationSnapshotForStorage = (snapshot, userId, existingSnapshot = null) => {
  const now = new Date().toISOString();
  const id = String(snapshot.id || existingSnapshot?.id || makeReconciliationSnapshotId());
  const seenSymbols = new Set();
  const holdings = (snapshot.holdings || [])
    .map((holding) => ({
      symbol: normalizeSymbol(holding.symbol),
      brokerQuantity: toNumber(holding.brokerQuantity),
      brokerCostBasis: optionalNumber(holding.brokerCostBasis),
      brokerMarketValue: optionalNumber(holding.brokerMarketValue),
      notes: String(holding.notes || '').trim(),
    }))
    .filter((holding) => {
      if (!holding.symbol || seenSymbols.has(holding.symbol)) return false;
      seenSymbols.add(holding.symbol);
      return true;
    });

  return {
    id,
    userId,
    accountId: String(snapshot.accountId || existingSnapshot?.accountId || 'firstrade').trim() || 'firstrade',
    date: snapshot.date,
    currency: String(snapshot.currency || 'USD').trim().toUpperCase() || 'USD',
    brokerCashBalance: toNumber(snapshot.brokerCashBalance),
    brokerTotalMarketValue: optionalNumber(snapshot.brokerTotalMarketValue),
    brokerTotalAccountValue: optionalNumber(snapshot.brokerTotalAccountValue),
    notes: String(snapshot.notes || '').trim(),
    holdings,
    createdAt: existingSnapshot?.createdAt || snapshot.createdAt || now,
    updatedAt: now,
  };
};

export const subscribeReconciliationSnapshots = (db, userId, onSnapshots, onError) => {
  const snapshotsRef = collection(db, 'users', userId, 'reconciliationSnapshots');
  return onSnapshot(
    snapshotsRef,
    (snapshot) => {
      const snapshots = snapshot.docs
        .map((item) => item.data())
        .sort((a, b) => {
          const aKey = `${a.date || ''}:${a.createdAt || ''}`;
          const bKey = `${b.date || ''}:${b.createdAt || ''}`;
          return bKey.localeCompare(aKey);
        });
      onSnapshots(snapshots);
    },
    onError,
  );
};

export const saveReconciliationSnapshot = async (db, userId, snapshot) => {
  const snapshotRef = doc(db, 'users', userId, 'reconciliationSnapshots', snapshot.id);
  await setDoc(snapshotRef, snapshot);
};

export const deleteReconciliationSnapshot = async (db, userId, snapshotId) => {
  await deleteDoc(doc(db, 'users', userId, 'reconciliationSnapshots', snapshotId));
};
