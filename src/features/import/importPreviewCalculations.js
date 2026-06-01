import { parseCsvText } from './csvParser.js';
import {
  ACTIVITY_TYPES,
  CSV_TYPES,
  buildImportFingerprint,
  classifyFirstradeActivity,
  detectFirstradeCsvType,
  mapFirstradeRow,
  toCashMovementDraft,
  toReconciliationHoldingDraft,
  toStockTradeDraft,
  validateImportedDraft,
} from './firstradeMapping.js';

export const PREVIEW_STATUS = {
  OK: 'OK',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  DUPLICATE: 'DUPLICATE',
  IGNORED: 'IGNORED',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
};

export const DUPLICATE_STATUS = {
  NEW: 'NEW',
  DUPLICATE_EXISTING: 'DUPLICATE_EXISTING',
  DUPLICATE_IN_FILE: 'DUPLICATE_IN_FILE',
};

const CASH_ACTIVITY_TYPES = new Set([
  ACTIVITY_TYPES.DIVIDEND,
  ACTIVITY_TYPES.WITHHOLDING_TAX,
  ACTIVITY_TYPES.INTEREST,
  ACTIVITY_TYPES.FEE,
  ACTIVITY_TYPES.DEPOSIT,
  ACTIVITY_TYPES.WITHDRAWAL,
  ACTIVITY_TYPES.ADJUSTMENT,
]);

const getDraftTarget = (draft) => {
  if (!draft) return 'Unknown';
  if (Object.prototype.hasOwnProperty.call(draft, 'side')) return 'Stock Trade';
  if (Object.prototype.hasOwnProperty.call(draft, 'brokerQuantity')) return 'Reconciliation Holding';
  return 'Cash Movement';
};

const getDraftAmountOrQuantity = (draft) => {
  if (!draft) return '';
  if (Object.prototype.hasOwnProperty.call(draft, 'side')) return draft.quantity;
  if (Object.prototype.hasOwnProperty.call(draft, 'brokerQuantity')) return draft.brokerQuantity;
  return draft.amount;
};

export const createDraftFromMappedRow = (mappedRow, csvType) => {
  if (csvType === CSV_TYPES.UNKNOWN) return null;
  if (csvType === CSV_TYPES.POSITIONS) return toReconciliationHoldingDraft(mappedRow);

  const activityType = mappedRow.activityType || classifyFirstradeActivity(mappedRow);
  if ([ACTIVITY_TYPES.STOCK_TRADE_BUY, ACTIVITY_TYPES.STOCK_TRADE_SELL, ACTIVITY_TYPES.DIVIDEND_REINVESTMENT].includes(activityType)) {
    return toStockTradeDraft(mappedRow);
  }
  if (CASH_ACTIVITY_TYPES.has(activityType)) return toCashMovementDraft(mappedRow);
  return null;
};

const existingStockFingerprints = (stockTrades = []) =>
  stockTrades.map((trade) => trade.importFingerprint || buildImportFingerprint({ ...trade, accountId: trade.accountId || 'firstrade' }));

const existingCashFingerprints = (cashMovements = []) =>
  cashMovements.map((movement) => movement.importFingerprint || buildImportFingerprint({ ...movement, accountId: movement.accountId || 'firstrade' }));

const existingPositionFingerprints = (reconciliationSnapshots = []) =>
  reconciliationSnapshots.flatMap((snapshot) =>
    (snapshot.holdings || []).map((holding) =>
      holding.importFingerprint ||
      buildImportFingerprint({
        ...holding,
        accountId: snapshot.accountId || holding.accountId || 'firstrade',
        date: snapshot.date || holding.date || '',
      }),
    ),
  );

export const buildExistingImportFingerprintSet = ({
  stockTrades = [],
  cashMovements = [],
  reconciliationSnapshots = [],
} = {}) =>
  new Set([
    ...existingStockFingerprints(stockTrades),
    ...existingCashFingerprints(cashMovements),
    ...existingPositionFingerprints(reconciliationSnapshots),
  ]);

const getDuplicateStatus = (fingerprint, seenFingerprints, existingFingerprints) => {
  if (!fingerprint) return DUPLICATE_STATUS.NEW;
  if (seenFingerprints.has(fingerprint)) return DUPLICATE_STATUS.DUPLICATE_IN_FILE;
  if (existingFingerprints.has(fingerprint)) return DUPLICATE_STATUS.DUPLICATE_EXISTING;
  return DUPLICATE_STATUS.NEW;
};

const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

export const isBeforeTrackingStartDate = (rowDate, trackingStartDate = '') => {
  if (!trackingStartDate || !isIsoDate(trackingStartDate)) return false;
  if (!isIsoDate(rowDate)) return false;
  return rowDate < trackingStartDate;
};

const getStatus = ({ activityType, errors, warnings, duplicateStatus, outOfScope }) => {
  if (activityType === ACTIVITY_TYPES.IGNORED) return PREVIEW_STATUS.IGNORED;
  if (errors.length > 0) return PREVIEW_STATUS.ERROR;
  if (outOfScope) return PREVIEW_STATUS.OUT_OF_SCOPE;
  if (duplicateStatus !== DUPLICATE_STATUS.NEW) return PREVIEW_STATUS.DUPLICATE;
  if (warnings.length > 0) return PREVIEW_STATUS.WARNING;
  return PREVIEW_STATUS.OK;
};

export const buildImportPreview = ({
  headers = [],
  rows = [],
  existingStockTrades = [],
  existingCashMovements = [],
  existingReconciliationSnapshots = [],
  trackingStartDate = '',
} = {}) => {
  const csvType = detectFirstradeCsvType(headers);
  const existingFingerprints = buildExistingImportFingerprintSet({
    stockTrades: existingStockTrades,
    cashMovements: existingCashMovements,
    reconciliationSnapshots: existingReconciliationSnapshots,
  });
  const seenFingerprints = new Set();

  const previewRows = rows.map((rawRow, index) => {
    const mappedRow = mapFirstradeRow(rawRow, csvType);
    const draft = createDraftFromMappedRow(mappedRow, csvType);
    const activityType = mappedRow.activityType || ACTIVITY_TYPES.UNKNOWN;
    const isIgnored = activityType === ACTIVITY_TYPES.IGNORED;
    const validation = draft ? validateImportedDraft(draft) : { ok: false, errors: [], warnings: [] };
    const errors = [...validation.errors];
    const warnings = [...validation.warnings];

    if (csvType === CSV_TYPES.UNKNOWN) errors.push('Unknown CSV type.');
    if (!draft && !isIgnored && csvType !== CSV_TYPES.UNKNOWN) {
      errors.push('Unable to map row to a supported import draft.');
      if (activityType === ACTIVITY_TYPES.UNKNOWN) warnings.push('Unknown activity type.');
    }

    const rowDate = draft?.tradeDate || draft?.date || mappedRow.date || '';
    const outOfScope = errors.length === 0 && !isIgnored && isBeforeTrackingStartDate(rowDate, trackingStartDate);
    const fingerprint = draft?.importFingerprint || '';
    const duplicateStatus = errors.length > 0 || isIgnored || outOfScope
      ? DUPLICATE_STATUS.NEW
      : getDuplicateStatus(fingerprint, seenFingerprints, existingFingerprints);
    if (fingerprint && errors.length === 0 && !isIgnored && !outOfScope) seenFingerprints.add(fingerprint);
    const status = getStatus({ activityType, errors, warnings, duplicateStatus, outOfScope });

    return {
      rowNumber: index + 2,
      csvType,
      activityType,
      targetDraft: getDraftTarget(draft),
      symbol: draft?.symbol || mappedRow.symbol || '',
      date: rowDate,
      amountOrQuantity: getDraftAmountOrQuantity(draft),
      status,
      duplicateStatus,
      errors,
      warnings,
      outOfScope,
      rawRow,
      mappedRow,
      draft,
      fingerprint,
      importable: status === PREVIEW_STATUS.OK,
    };
  });

  const summary = previewRows.reduce(
    (result, row) => {
      result.totalRows += 1;
      if (row.draft) result.mappedRows += 1;
      if (row.status === PREVIEW_STATUS.OK) result.okRows += 1;
      if (row.status === PREVIEW_STATUS.WARNING) result.warningRows += 1;
      if (row.status === PREVIEW_STATUS.ERROR) result.errorRows += 1;
      if (row.status === PREVIEW_STATUS.DUPLICATE) result.duplicateRows += 1;
      if (row.status === PREVIEW_STATUS.IGNORED) result.ignoredRows += 1;
      if (row.status === PREVIEW_STATUS.OUT_OF_SCOPE) result.skippedBeforeStartDateRows += 1;
      if (row.importable) result.importableRows += 1;
      return result;
    },
    {
      csvType,
      totalRows: 0,
      mappedRows: 0,
      okRows: 0,
      warningRows: 0,
      errorRows: 0,
      ignoredRows: 0,
      skippedBeforeStartDateRows: 0,
      duplicateRows: 0,
      importableRows: 0,
    },
  );

  return { headers, csvType, rows: previewRows, summary };
};

export const buildImportPreviewFromCsvText = (csvText, options = {}) => {
  const parsed = parseCsvText(csvText);
  return {
    ...buildImportPreview({
      headers: parsed.headers,
      rows: parsed.rows,
      ...options,
    }),
    rawRowCount: parsed.rows.length,
  };
};
