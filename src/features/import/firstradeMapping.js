const HEADER_ALIASES = {
  date: ['date', 'trade date', 'transaction date', 'activity date', 'settlement date'],
  action: ['action', 'activity', 'type', 'transaction type'],
  symbol: ['symbol', 'ticker', 'security symbol'],
  quantity: ['quantity', 'qty', 'shares', 'share quantity'],
  price: ['price', 'trade price', 'execution price'],
  commission: ['commission', 'commissions'],
  fees: ['fee', 'fees', 'sec fee', 'reg fee'],
  amount: ['amount', 'net cash amount', 'cash amount'],
  netAmount: ['net amount'],
  grossAmount: ['gross amount', 'gross'],
  withholdingTax: ['withholding tax', 'tax withheld', 'foreign tax', 'foreign tax withheld'],
  description: ['description', 'security description', 'details', 'memo'],
  costBasis: ['cost basis', 'total cost basis', 'cost'],
  marketValue: ['market value', 'current value'],
};

const STOCK_BUY_TERMS = ['buy', 'bought', 'purchase'];
const STOCK_SELL_TERMS = ['sell', 'sold'];
const DIVIDEND_TERMS = ['dividend', 'qualified dividend', 'cash dividend'];
const WITHHOLDING_TERMS = ['withholding', 'tax withheld', 'foreign tax'];
const INTEREST_TERMS = ['interest'];
const FEE_TERMS = ['fee', 'adr fee', 'reorganization fee'];
const DEPOSIT_TERMS = ['deposit', 'ach credit', 'wire in', 'transfer in'];
const WITHDRAWAL_TERMS = ['withdrawal', 'ach debit', 'wire out', 'transfer out'];
const ADJUSTMENT_TERMS = ['adjustment', 'journal', 'correction'];

export const CSV_TYPES = {
  STOCK_ACTIVITY: 'stock_activity',
  CASH_ACTIVITY: 'cash_activity',
  POSITIONS: 'positions',
  UNKNOWN: 'unknown',
};

export const ACTIVITY_TYPES = {
  STOCK_TRADE_BUY: 'stock_trade_buy',
  STOCK_TRADE_SELL: 'stock_trade_sell',
  DIVIDEND: 'dividend',
  WITHHOLDING_TAX: 'withholding_tax',
  INTEREST: 'interest',
  FEE: 'fee',
  DEPOSIT: 'deposit',
  WITHDRAWAL: 'withdrawal',
  ADJUSTMENT: 'adjustment',
  UNKNOWN: 'unknown',
};

export const normalizeHeader = (header) =>
  String(header || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const normalizeSymbol = (symbol) => String(symbol || '').trim().toUpperCase();

const normalizeActionText = (value) => String(value || '').trim().toLowerCase();

const hasAny = (headers, aliases) => aliases.some((alias) => headers.has(alias));

const getByAliases = (row, aliases) => {
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, alias)) return row[alias];
  }
  return '';
};

const normalizeRawRowKeys = (rawRow = {}) =>
  Object.entries(rawRow).reduce((result, [key, value]) => {
    result[normalizeHeader(key)] = value;
    return result;
  }, {});

const isValidDateParts = (year, month, day) => {
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const formatDate = (year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

export const parseFirstradeDate = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;

  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch.map(Number);
    return isValidDateParts(year, month, day) ? formatDate(year, month, day) : null;
  }

  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!slashMatch) return null;

  const first = Number(slashMatch[1]);
  const second = Number(slashMatch[2]);
  const year = Number(slashMatch[3]);

  if (first >= 1 && first <= 12 && second > 12) {
    return isValidDateParts(year, first, second) ? formatDate(year, first, second) : null;
  }

  return null;
};

export const parseFirstradeNumber = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const isParenthesized = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[,$%\s]/g, '').replace(/[()]/g, '');
  if (!cleaned) return null;
  const number = Number(cleaned);
  if (!Number.isFinite(number)) return null;
  return isParenthesized ? -Math.abs(number) : number;
};

export const parseFirstradeCurrencyAmount = parseFirstradeNumber;

export const detectFirstradeCsvType = (headers = []) => {
  const normalizedHeaders = new Set(headers.map(normalizeHeader));
  const hasDate = hasAny(normalizedHeaders, HEADER_ALIASES.date);
  const hasAction = hasAny(normalizedHeaders, HEADER_ALIASES.action);
  const hasSymbol = hasAny(normalizedHeaders, HEADER_ALIASES.symbol);
  const hasQuantity = hasAny(normalizedHeaders, HEADER_ALIASES.quantity);
  const hasPrice = hasAny(normalizedHeaders, HEADER_ALIASES.price);
  const hasAmount = hasAny(normalizedHeaders, HEADER_ALIASES.amount);
  const hasCostBasis = hasAny(normalizedHeaders, HEADER_ALIASES.costBasis);
  const hasMarketValue = hasAny(normalizedHeaders, HEADER_ALIASES.marketValue);

  if (hasSymbol && hasQuantity && (hasCostBasis || hasMarketValue)) return CSV_TYPES.POSITIONS;
  if (hasDate && hasAction && hasSymbol && hasQuantity && hasPrice) return CSV_TYPES.STOCK_ACTIVITY;
  if (hasDate && hasAction && hasAmount && !hasQuantity) return CSV_TYPES.CASH_ACTIVITY;

  return CSV_TYPES.UNKNOWN;
};

export const classifyFirstradeActivity = (row = {}) => {
  const normalizedRow = normalizeRawRowKeys(row);
  const actionText = normalizeActionText(row.activity || row.action || row.type || getByAliases(normalizedRow, HEADER_ALIASES.action));
  const descriptionText = normalizeActionText(row.description || getByAliases(normalizedRow, HEADER_ALIASES.description));
  const text = `${actionText} ${descriptionText}`.trim();

  if (!text) return ACTIVITY_TYPES.UNKNOWN;
  if (WITHHOLDING_TERMS.some((term) => text.includes(term))) return ACTIVITY_TYPES.WITHHOLDING_TAX;
  if (DIVIDEND_TERMS.some((term) => text.includes(term))) return ACTIVITY_TYPES.DIVIDEND;
  if (STOCK_BUY_TERMS.some((term) => text.includes(term))) return ACTIVITY_TYPES.STOCK_TRADE_BUY;
  if (STOCK_SELL_TERMS.some((term) => text.includes(term))) return ACTIVITY_TYPES.STOCK_TRADE_SELL;
  if (INTEREST_TERMS.some((term) => text.includes(term))) return ACTIVITY_TYPES.INTEREST;
  if (FEE_TERMS.some((term) => text.includes(term))) return ACTIVITY_TYPES.FEE;
  if (DEPOSIT_TERMS.some((term) => text.includes(term))) return ACTIVITY_TYPES.DEPOSIT;
  if (WITHDRAWAL_TERMS.some((term) => text.includes(term))) return ACTIVITY_TYPES.WITHDRAWAL;
  if (ADJUSTMENT_TERMS.some((term) => text.includes(term))) return ACTIVITY_TYPES.ADJUSTMENT;
  return ACTIVITY_TYPES.UNKNOWN;
};

export const mapFirstradeRow = (rawRow = {}, csvType = CSV_TYPES.UNKNOWN) => {
  const row = normalizeRawRowKeys(rawRow);
  const mapped = {
    csvType,
    rawRow,
    date: parseFirstradeDate(getByAliases(row, HEADER_ALIASES.date)),
    action: String(getByAliases(row, HEADER_ALIASES.action) || '').trim(),
    symbol: normalizeSymbol(getByAliases(row, HEADER_ALIASES.symbol)),
    quantity: parseFirstradeNumber(getByAliases(row, HEADER_ALIASES.quantity)),
    price: parseFirstradeCurrencyAmount(getByAliases(row, HEADER_ALIASES.price)),
    commission: parseFirstradeCurrencyAmount(getByAliases(row, HEADER_ALIASES.commission)),
    fees: parseFirstradeCurrencyAmount(getByAliases(row, HEADER_ALIASES.fees)),
    amount: parseFirstradeCurrencyAmount(getByAliases(row, HEADER_ALIASES.amount)),
    grossAmount: parseFirstradeCurrencyAmount(getByAliases(row, HEADER_ALIASES.grossAmount)),
    netAmount: parseFirstradeCurrencyAmount(getByAliases(row, HEADER_ALIASES.netAmount)),
    withholdingTax: parseFirstradeCurrencyAmount(getByAliases(row, HEADER_ALIASES.withholdingTax)),
    description: String(getByAliases(row, HEADER_ALIASES.description) || '').trim(),
    costBasis: parseFirstradeCurrencyAmount(getByAliases(row, HEADER_ALIASES.costBasis)),
    marketValue: parseFirstradeCurrencyAmount(getByAliases(row, HEADER_ALIASES.marketValue)),
    currency: 'USD',
  };

  mapped.activityType = classifyFirstradeActivity(mapped);
  return mapped;
};

const absoluteOrZero = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.abs(number) : 0;
};

const optionalAbsNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.abs(number) : undefined;
};

const makeNotes = (mappedRow) => mappedRow.description || mappedRow.action || '';

const draftBase = (mappedRow) => ({
  accountId: 'firstrade',
  currency: 'USD',
  notes: makeNotes(mappedRow),
  source: 'firstrade_csv',
});

export const toStockTradeDraft = (mappedRow = {}) => {
  const activityType = mappedRow.activityType || classifyFirstradeActivity(mappedRow);
  if (![ACTIVITY_TYPES.STOCK_TRADE_BUY, ACTIVITY_TYPES.STOCK_TRADE_SELL].includes(activityType)) return null;

  const draft = {
    ...draftBase(mappedRow),
    symbol: normalizeSymbol(mappedRow.symbol),
    side: activityType === ACTIVITY_TYPES.STOCK_TRADE_SELL ? 'sell' : 'buy',
    tradeDate: mappedRow.date || '',
    tradeTime: mappedRow.tradeTime || '',
    quantity: absoluteOrZero(mappedRow.quantity),
    price: absoluteOrZero(mappedRow.price),
    commission: absoluteOrZero(mappedRow.commission),
    fees: absoluteOrZero(mappedRow.fees),
  };

  draft.importFingerprint = buildImportFingerprint(draft);
  return draft;
};

const getCashMovementType = (activityType) => ({
  [ACTIVITY_TYPES.DIVIDEND]: 'dividend',
  [ACTIVITY_TYPES.WITHHOLDING_TAX]: 'withholding_tax',
  [ACTIVITY_TYPES.INTEREST]: 'interest',
  [ACTIVITY_TYPES.FEE]: 'fee',
  [ACTIVITY_TYPES.DEPOSIT]: 'deposit',
  [ACTIVITY_TYPES.WITHDRAWAL]: 'withdrawal',
  [ACTIVITY_TYPES.ADJUSTMENT]: 'adjustment',
}[activityType] || null);

export const toCashMovementDraft = (mappedRow = {}) => {
  const activityType = mappedRow.activityType || classifyFirstradeActivity(mappedRow);
  const type = getCashMovementType(activityType);
  if (!type) return null;

  const rawAmount = Number.isFinite(Number(mappedRow.amount)) ? Number(mappedRow.amount) : 0;
  const draft = {
    ...draftBase(mappedRow),
    type,
    date: mappedRow.date || '',
    symbol: normalizeSymbol(mappedRow.symbol),
    amount: type === 'adjustment' ? rawAmount : Math.abs(rawAmount),
  };

  if (type === 'dividend') {
    const grossAmount = optionalAbsNumber(mappedRow.grossAmount);
    const withholdingTax = optionalAbsNumber(mappedRow.withholdingTax);
    const netAmount = optionalAbsNumber(mappedRow.netAmount ?? mappedRow.amount);
    if (grossAmount !== undefined) draft.grossAmount = grossAmount;
    if (withholdingTax !== undefined) draft.withholdingTax = withholdingTax;
    if (netAmount !== undefined) draft.netAmount = netAmount;
    draft.amount = netAmount ?? grossAmount ?? Math.abs(rawAmount);
  }

  draft.importFingerprint = buildImportFingerprint(draft);
  return draft;
};

export const toReconciliationHoldingDraft = (mappedRow = {}) => {
  const draft = {
    symbol: normalizeSymbol(mappedRow.symbol),
    brokerQuantity: absoluteOrZero(mappedRow.quantity),
    brokerCostBasis: optionalAbsNumber(mappedRow.costBasis),
    brokerMarketValue: optionalAbsNumber(mappedRow.marketValue),
    notes: makeNotes(mappedRow),
    accountId: 'firstrade',
    date: mappedRow.date || '',
    source: 'firstrade_csv',
  };

  draft.importFingerprint = buildImportFingerprint(draft);
  return draft;
};

const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));

const hasNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

const validateStockDraft = (draft, errors) => {
  if (!draft.symbol || draft.symbol !== draft.symbol.toUpperCase()) errors.push('symbol is required and must be uppercase.');
  if (!['buy', 'sell'].includes(draft.side)) errors.push('side must be buy or sell.');
  if (!isIsoDate(draft.tradeDate)) errors.push('tradeDate must be YYYY-MM-DD.');
  if (!hasNumber(draft.quantity) || Number(draft.quantity) <= 0) errors.push('quantity must be greater than 0.');
  if (!hasNumber(draft.price) || Number(draft.price) < 0) errors.push('price must be 0 or greater.');
};

const validateCashDraft = (draft, errors) => {
  if (!isIsoDate(draft.date)) errors.push('date must be YYYY-MM-DD.');
  if (!draft.type) errors.push('type is required.');
  if (draft.type !== 'adjustment' && (!hasNumber(draft.amount) || Number(draft.amount) < 0)) errors.push('amount must be 0 or greater.');
  if (draft.type === 'adjustment' && !hasNumber(draft.amount)) errors.push('adjustment amount must be numeric.');
  if (draft.type === 'dividend' && !hasNumber(draft.amount) && !hasNumber(draft.netAmount) && !hasNumber(draft.grossAmount)) {
    errors.push('dividend requires amount, netAmount, or grossAmount.');
  }
};

const validateHoldingDraft = (draft, errors) => {
  if (!draft.symbol || draft.symbol !== draft.symbol.toUpperCase()) errors.push('symbol is required and must be uppercase.');
  if (!hasNumber(draft.brokerQuantity) || Number(draft.brokerQuantity) < 0) errors.push('brokerQuantity must be 0 or greater.');
};

export const validateImportedDraft = (draft = {}) => {
  const errors = [];
  const warnings = [];

  if (!draft || typeof draft !== 'object') {
    return { ok: false, errors: ['draft is required.'], warnings };
  }

  if (draft.activityType === ACTIVITY_TYPES.UNKNOWN || draft.type === ACTIVITY_TYPES.UNKNOWN) {
    warnings.push('Unknown activity type. Review manually before importing.');
  }

  if (Object.prototype.hasOwnProperty.call(draft, 'side')) validateStockDraft(draft, errors);
  else if (Object.prototype.hasOwnProperty.call(draft, 'brokerQuantity')) validateHoldingDraft(draft, errors);
  else validateCashDraft(draft, errors);

  if (!draft.importFingerprint) warnings.push('Missing importFingerprint; duplicate detection will be weaker.');

  return { ok: errors.length === 0, errors, warnings };
};

const fingerprintValue = (value) => {
  if (value === null || value === undefined || value === '') return '';
  if (Number.isFinite(Number(value))) return String(Number(value));
  return String(value).trim().toLowerCase();
};

export const buildImportFingerprint = (draft = {}) => {
  const accountId = fingerprintValue(draft.accountId || 'firstrade');

  if (Object.prototype.hasOwnProperty.call(draft, 'side')) {
    return [
      'stock',
      accountId,
      fingerprintValue(draft.side),
      fingerprintValue(draft.tradeDate),
      fingerprintValue(draft.symbol),
      fingerprintValue(draft.quantity),
      fingerprintValue(draft.price),
      fingerprintValue(draft.commission),
      fingerprintValue(draft.fees),
    ].join('|');
  }

  if (Object.prototype.hasOwnProperty.call(draft, 'brokerQuantity')) {
    return [
      'position',
      accountId,
      fingerprintValue(draft.date),
      fingerprintValue(draft.symbol),
      fingerprintValue(draft.brokerQuantity),
      fingerprintValue(draft.brokerCostBasis),
      fingerprintValue(draft.brokerMarketValue),
    ].join('|');
  }

  return [
    'cash',
    accountId,
    fingerprintValue(draft.type),
    fingerprintValue(draft.date),
    fingerprintValue(draft.symbol),
    fingerprintValue(draft.amount),
    fingerprintValue(draft.grossAmount),
    fingerprintValue(draft.withholdingTax),
    fingerprintValue(draft.notes),
  ].join('|');
};
