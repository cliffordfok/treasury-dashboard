import { doc, writeBatch } from 'firebase/firestore';
import { buildConfirmImportPlan } from './importConfirmCalculations.js';

const FIRESTORE_BATCH_LIMIT = 450;

const chunk = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
};

export const commitFirstradeImport = async ({
  db,
  userId,
  previewRows = [],
  existingStockTrades = [],
  existingCashMovements = [],
} = {}) => {
  if (!db) throw new Error('Firestore db is required.');
  if (!userId) throw new Error('User is required.');

  const plan = buildConfirmImportPlan({
    previewRows,
    userId,
    existingStockTrades,
    existingCashMovements,
  });

  const writes = [
    ...plan.stockTrades.map((payload) => ({ collectionName: 'stockTrades', payload })),
    ...plan.cashMovements.map((payload) => ({ collectionName: 'cashMovements', payload })),
  ];

  if (writes.length === 0) {
    return {
      ...plan,
      result: {
        importedStockTrades: 0,
        importedCashMovements: 0,
        skippedRows: plan.skippedRows.length,
        failedRows: 0,
        failures: [],
      },
    };
  }

  const failures = [];
  try {
    for (const writeChunk of chunk(writes, FIRESTORE_BATCH_LIMIT)) {
      const batch = writeBatch(db);
      writeChunk.forEach(({ collectionName, payload }) => {
        batch.set(doc(db, 'users', userId, collectionName, payload.id), payload);
      });
      await batch.commit();
    }
  } catch (error) {
    failures.push({
      rowNumber: null,
      reason: error.message || String(error),
    });
  }

  return {
    ...plan,
    result: {
      importedStockTrades: failures.length ? 0 : plan.stockTrades.length,
      importedCashMovements: failures.length ? 0 : plan.cashMovements.length,
      skippedRows: plan.skippedRows.length,
      failedRows: failures.length ? writes.length : 0,
      failures,
    },
  };
};
