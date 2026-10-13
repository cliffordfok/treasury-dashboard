import { isValidISODate } from './treasuryMath.js';

const SECURITY_TYPES = { Bill: 't-bill', Note: 't-note', Bond: 't-bond' };
// Fiscal Data has published the coupon under more than one name; accept either.
const COUPON_FIELDS = ['int_rate', 'interest_rate', 'interest_rate_pct'];
const MIN_OUTSTANDING_SECURITIES = 100;

export const normalizeCusip = (value) => String(value ?? '').trim().toUpperCase();

// Standard CUSIP check digit (modulus 10, double-add-double).
export const isValidCusip = (value) => {
  const cusip = normalizeCusip(value);
  if (!/^[0-9A-Z*@#]{8}[0-9]$/.test(cusip)) return false;
  let sum = 0;
  for (let index = 0; index < 8; index += 1) {
    const character = cusip[index];
    let digit;
    if (/[0-9]/.test(character)) digit = Number(character);
    else if (/[A-Z]/.test(character)) digit = character.charCodeAt(0) - 55;
    else digit = { '*': 36, '@': 37, '#': 38 }[character];
    if (index % 2 === 1) digit *= 2;
    sum += Math.floor(digit / 10) + (digit % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(cusip[8]);
};

const readField = (row, field) => {
  const value = row?.[field];
  return value === undefined || value === null || value === '' || value === 'null' ? null : value;
};

// Collapses auction rows (a reopened issue appears once per auction) into one
// record per CUSIP with the terms the ledger needs.
export const normalizeAuctionRows = (rows) => {
  if (!Array.isArray(rows)) throw new Error('Fiscal Data 回應格式無效');
  const byCusip = new Map();
  for (const row of rows) {
    const type = SECURITY_TYPES[readField(row, 'security_type')];
    const cusip = normalizeCusip(readField(row, 'cusip'));
    if (!type || !isValidCusip(cusip)) continue;
    const maturityDate = readField(row, 'maturity_date');
    const issueDate = readField(row, 'issue_date');
    if (!isValidISODate(maturityDate)) continue;

    let couponRate = 0;
    if (type !== 't-bill') {
      const rawRate = COUPON_FIELDS.map((field) => readField(row, field)).find((value) => value != null);
      couponRate = Number(rawRate);
      if (rawRate == null || !Number.isFinite(couponRate) || couponRate < 0 || couponRate > 20) continue;
    }

    const existing = byCusip.get(cusip);
    if (existing && (existing.maturityDate !== maturityDate || existing.couponRate !== couponRate)) {
      throw new Error(`CUSIP ${cusip} 的條款在不同拍賣中不一致`);
    }
    const earliestIssue = [existing?.issueDate, isValidISODate(issueDate) ? issueDate : null]
      .filter(Boolean)
      .sort()[0] ?? null;
    byCusip.set(cusip, {
      cusip,
      type,
      term: String(readField(row, 'security_term') ?? existing?.term ?? ''),
      issueDate: earliestIssue,
      maturityDate,
      couponRate,
    });
  }
  return [...byCusip.values()].sort((left, right) => left.maturityDate.localeCompare(right.maturityDate)
    || left.cusip.localeCompare(right.cusip));
};

export const validateSecuritiesFeed = (data, { minimum = MIN_OUTSTANDING_SECURITIES } = {}) => {
  if (!data || typeof data !== 'object' || !Array.isArray(data.securities)) {
    throw new Error('treasury-securities.json 格式無效');
  }
  const securities = data.securities.filter((security) => (
    isValidCusip(security?.cusip)
    && Object.values(SECURITY_TYPES).includes(security.type)
    && isValidISODate(security.maturityDate)
    && Number.isFinite(security.couponRate)
  ));
  if (securities.length !== data.securities.length) throw new Error('treasury-securities.json 包含無效項目');
  if (securities.length < minimum) throw new Error(`國債資料不足：只有 ${securities.length} 隻`);
  for (const type of Object.values(SECURITY_TYPES)) {
    if (!securities.some((security) => security.type === type)) throw new Error(`國債資料缺少 ${type}`);
  }
  return { ...data, securities };
};

export const buildSecuritiesIndex = (feed) => new Map(feed.securities.map((security) => [security.cusip, security]));

export const securityToTradeTerms = (security) => ({
  cusip: security.cusip,
  type: security.type,
  maturityDate: security.maturityDate,
  couponRate: security.type === 't-bill' ? 0 : security.couponRate,
  couponFrequency: security.type === 't-bill' ? 0 : 2,
});
