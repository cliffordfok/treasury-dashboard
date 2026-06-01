import { getCashMovementImpact } from '../cash/cashCalculations.js';
import { getStockTradeCashImpact, normalizeSymbol, toNumber } from '../stocks/stockCalculations.js';
import { DUPLICATE_STATUS, PREVIEW_STATUS, isBeforeTrackingStartDate } from './importPreviewCalculations.js';
import { buildImportFingerprint, validateImportedDraft } from './firstradeMapping.js';

const IMPORTABLE_TARGETS = new Set(['Stock Trade', 'Cash Movement']);

const makeImportId = (prefix, rowNumber, fingerprint) => {
  const suffix = String(fingerprint || `${Date.now()}-${Math.random()}`).replace(/[^a-z0-9]+/gi, '-').slice(0, 48);
  return `${prefix}-${rowNumber || 'row'}-${suffix || Math.random().toString(36).slice(2, 8)}`;
};

const optionalNumber = (value) => {
  if (value === '' || value === null || value === undefined) return null;
  return toNumber(value);
};

export const normalizeStockImportDraft = (draft, userId, rowNumber) => {
  const now = new Date().toISOString();
  const id = String(draft.id || makeImportId('stock-import', rowNumber, draft.importFingerprint));
  return {
    id,
    userId,
    accountId: String(draft.accountId || 'firstrade').trim() || 'firstrade',
    symbol: normalizeSymbol(draft.symbol),
    name: String(draft.name || '').trim(),
    side: draft.side === 'sell' ? 'sell' : 'buy',
    tradeDate: draft.tradeDate,
    tradeTime: String(draft.tradeTime || '').trim(),
    quantity: toNumber(draft.quantity),
    price: toNumber(draft.price),
    commission: toNumber(draft.commission),
    fees: toNumber(draft.fees),
    currency: String(draft.currency || 'USD').trim().toUpperCase() || 'USD',
    notes: String(draft.notes || '').trim(),
    source: String(draft.source || 'firstrade_csv').trim() || 'firstrade_csv',
    importFingerprint: String(draft.importFingerprint || '').trim(),
    createdAt: now,
    updatedAt: now,
  };
};

export const normalizeCashImportDraft = (draft, userId, rowNumber) => {
  const now = new Date().toISOString();
  const id = String(draft.id || makeImportId('cash-import', rowNumber, draft.importFingerprint));
  const normalized = {
    id,
    userId,
    accountId: String(draft.accountId || 'firstrade').trim() || 'firstrade',
    type: draft.type,
    date: draft.date,
    symbol: normalizeSymbol(draft.symbol),
    currency: String(draft.currency || 'USD').trim().toUpperCase() || 'USD',
    amount: optionalNumber(draft.amount),
    grossAmount: optionalNumber(draft.grossAmount),
    withholdingTax: optionalNumber(draft.withholdingTax),
    netAmount: optionalNumber(draft.netAmount),
    notes: String(draft.notes || '').trim(),
    source: String(draft.source || 'firstrade_csv').trim() || 'firstrade_csv',
    importFingerprint: String(draft.importFingerprint || '').trim(),
    createdAt: now,
    updatedAt: now,
  };

  if (normalized.type === 'dividend' && normalized.amount === null) {
    normalized.amount = getCashMovementImpact(normalized);
  } else {
    normalized.amount = toNumber(normalized.amount);
  }

  return normalized;
};

const hasExistingFingerprint = (draft, existingStockTrades = [], existingCashMovements = []) => {
  const fingerprint = draft?.importFingerprint || '';
  if (!fingerprint) return false;
  const stockFingerprints = existingStockTrades.map((trade) => trade.importFingerprint || buildImportFingerprint({ ...trade, accountId: trade.accountId || 'firstrade' }));
  const cashFingerprints = existingCashMovements.map((movement) => movement.importFingerprint || buildImportFingerprint({ ...movement, accountId: movement.accountId || 'firstrade' }));
  return new Set([...stockFingerprints, ...cashFingerprints]).has(fingerprint);
};

export const classifyConfirmImportRow = (row, seenFingerprints, existingStockTrades = [], existingCashMovements = [], trackingStartDate = '') => {
  if (row.status === PREVIEW_STATUS.IGNORED) return { importable: false, reason: 'ignored' };
  if (!row?.draft) return { importable: false, reason: 'missing_draft' };
  if (row.status === PREVIEW_STATUS.ERROR) return { importable: false, reason: 'error' };
  if (row.status === PREVIEW_STATUS.OUT_OF_SCOPE) return { importable: false, reason: 'before_start_date' };
  if (row.status === PREVIEW_STATUS.WARNING) return { importable: false, reason: 'warning' };
  if (row.status === PREVIEW_STATUS.DUPLICATE || row.duplicateStatus !== DUPLICATE_STATUS.NEW) return { importable: false, reason: 'duplicate' };
  if (!IMPORTABLE_TARGETS.has(row.targetDraft)) return { importable: false, reason: 'position' };

  const validation = validateImportedDraft(row.draft);
  if (!validation.ok || validation.warnings.length > 0) return { importable: false, reason: validation.ok ? 'warning' : 'error' };

  const rowDate = row.draft.tradeDate || row.draft.date || row.date || '';
  if (isBeforeTrackingStartDate(rowDate, trackingStartDate)) return { importable: false, reason: 'before_start_date' };

  const fingerprint = row.draft.importFingerprint || '';
  if (!fingerprint) return { importable: false, reason: 'missing_fingerprint' };
  if (seenFingerprints.has(fingerprint)) return { importable: false, reason: 'duplicate' };
  if (hasExistingFingerprint(row.draft, existingStockTrades, existingCashMovements)) return { importable: false, reason: 'duplicate' };

  seenFingerprints.add(fingerprint);
  return { importable: true, reason: 'importable' };
};

const emptySummary = () => ({
  stockTradeRows: 0,
  cashMovementRows: 0,
  skippedDuplicateRows: 0,
  skippedErrorRows: 0,
  skippedWarningRows: 0,
  skippedIgnoredRows: 0,
  skippedBeforeStartDateRows: 0,
  skippedPositionRows: 0,
  skippedOtherRows: 0,
  importableRows: 0,
  stockTradeCashImpact: 0,
  cashMovementImpact: 0,
  totalCashImpact: 0,
  buyRows: 0,
  sellRows: 0,
  dividendRows: 0,
  interestRows: 0,
  feeOrWithholdingRows: 0,
});

const incrementSkip = (summary, reason) => {
  if (reason === 'duplicate') summary.skippedDuplicateRows += 1;
  else if (reason === 'error' || reason === 'missing_draft' || reason === 'missing_fingerprint') summary.skippedErrorRows += 1;
  else if (reason === 'warning') summary.skippedWarningRows += 1;
  else if (reason === 'ignored') summary.skippedIgnoredRows += 1;
  else if (reason === 'before_start_date') summary.skippedBeforeStartDateRows += 1;
  else if (reason === 'position') summary.skippedPositionRows += 1;
  else summary.skippedOtherRows += 1;
};

export const buildConfirmImportPlan = ({
  previewRows = [],
  userId = '',
  existingStockTrades = [],
  existingCashMovements = [],
  trackingStartDate = '',
} = {}) => {
  const summary = emptySummary();
  const seenFingerprints = new Set();
  const stockTrades = [];
  const cashMovements = [];
  const skippedRows = [];

  previewRows.forEach((row) => {
    const classification = classifyConfirmImportRow(row, seenFingerprints, existingStockTrades, existingCashMovements, trackingStartDate);
    if (!classification.importable) {
      incrementSkip(summary, classification.reason);
      skippedRows.push({ rowNumber: row.rowNumber, reason: classification.reason, targetDraft: row.targetDraft, status: row.status });
      return;
    }

    if (row.targetDraft === 'Stock Trade') {
      const stockTrade = normalizeStockImportDraft(row.draft, userId, row.rowNumber);
      stockTrades.push(stockTrade);
      summary.stockTradeRows += 1;
      summary.stockTradeCashImpact += getStockTradeCashImpact(stockTrade);
      if (stockTrade.side === 'buy') summary.buyRows += 1;
      if (stockTrade.side === 'sell') summary.sellRows += 1;
    } else {
      const cashMovement = normalizeCashImportDraft(row.draft, userId, row.rowNumber);
      cashMovements.push(cashMovement);
      summary.cashMovementRows += 1;
      summary.cashMovementImpact += getCashMovementImpact(cashMovement);
      if (cashMovement.type === 'dividend') summary.dividendRows += 1;
      if (cashMovement.type === 'interest') summary.interestRows += 1;
      if (['fee', 'withholding_tax'].includes(cashMovement.type)) summary.feeOrWithholdingRows += 1;
    }
  });

  summary.importableRows = stockTrades.length + cashMovements.length;
  summary.totalCashImpact = summary.stockTradeCashImpact + summary.cashMovementImpact;

  return {
    stockTrades,
    cashMovements,
    skippedRows,
    summary,
  };
};
