import { collection, deleteDoc, doc, onSnapshot, setDoc } from 'firebase/firestore';
import { normalizeSymbol, toNumber } from '../stocks/stockCalculations.js';
import { getCashMovementImpact } from './cashCalculations.js';

const makeCashMovementId = () => `cash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0];

export const defaultCashMovementForm = () => ({
  accountId: 'firstrade',
  type: 'deposit',
  date: todayISO(),
  symbol: '',
  currency: 'USD',
  amount: '',
  grossAmount: '',
  withholdingTax: '',
  netAmount: '',
  notes: '',
});

const optionalNumber = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  return toNumber(value);
};

export const normalizeCashMovementForStorage = (movement, userId, existingMovement = null) => {
  const now = new Date().toISOString();
  const id = String(movement.id || existingMovement?.id || makeCashMovementId());
  const normalized = {
    id,
    userId,
    accountId: String(movement.accountId || existingMovement?.accountId || 'firstrade').trim() || 'firstrade',
    type: movement.type,
    date: movement.date,
    symbol: normalizeSymbol(movement.symbol),
    currency: String(movement.currency || 'USD').trim().toUpperCase() || 'USD',
    amount: optionalNumber(movement.amount),
    grossAmount: optionalNumber(movement.grossAmount),
    withholdingTax: optionalNumber(movement.withholdingTax),
    netAmount: optionalNumber(movement.netAmount),
    notes: String(movement.notes || '').trim(),
    createdAt: existingMovement?.createdAt || movement.createdAt || now,
    updatedAt: now,
  };

  if (normalized.type === 'dividend' && normalized.amount === null) {
    normalized.amount = getCashMovementImpact(normalized);
  } else {
    normalized.amount = toNumber(normalized.amount);
  }

  return normalized;
};

export const subscribeCashMovements = (db, userId, onMovements, onError) => {
  const movementsRef = collection(db, 'users', userId, 'cashMovements');
  return onSnapshot(
    movementsRef,
    (snapshot) => {
      const movements = snapshot.docs
        .map((item) => item.data())
        .sort((a, b) => {
          const aKey = `${a.date || ''}:${a.createdAt || ''}`;
          const bKey = `${b.date || ''}:${b.createdAt || ''}`;
          return bKey.localeCompare(aKey);
        });
      onMovements(movements);
    },
    onError,
  );
};

export const saveCashMovement = async (db, userId, movement) => {
  const movementRef = doc(db, 'users', userId, 'cashMovements', movement.id);
  await setDoc(movementRef, movement);
};

export const deleteCashMovement = async (db, userId, movementId) => {
  await deleteDoc(doc(db, 'users', userId, 'cashMovements', movementId));
};
