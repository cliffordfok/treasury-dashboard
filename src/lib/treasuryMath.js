export const MS_PER_DAY = 1000 * 60 * 60 * 24;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SUPPORTED_TREASURY_TYPES = new Set(['t-bill', 't-note', 't-bond']);

const padDatePart = (value) => String(value).padStart(2, '0');

export const formatDateOnly = (value) => {
  const date = value instanceof Date ? value : toDateAtMidnight(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
};

export const toDateAtMidnight = (value) => {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'string') {
    const match = ISO_DATE_PATTERN.exec(value);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const date = new Date(year, month - 1, day);
      if (
        date.getFullYear() !== year
        || date.getMonth() !== month - 1
        || date.getDate() !== day
      ) return null;
      date.setHours(0, 0, 0, 0);
      return date;
    }
  }

  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

export const isValidISODate = (value) => {
  if (!ISO_DATE_PATTERN.test(String(value || ''))) return false;
  const date = toDateAtMidnight(value);
  return Boolean(date && formatDateOnly(date) === value);
};

const getDayNumber = (value) => {
  const date = toDateAtMidnight(value);
  if (!date) return null;
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY;
};

export const calculateForwardDaysBetween = (date1, date2) => {
  const start = getDayNumber(date1);
  const end = getDayNumber(date2);
  if (start == null || end == null) return null;
  return end - start;
};

export const calculateDaysBetween = (date1, date2) => {
  const days = calculateForwardDaysBetween(date1, date2);
  return days == null ? null : Math.abs(days);
};

export const isMatured = (maturityDate, valuationDate = new Date()) => {
  const maturity = toDateAtMidnight(maturityDate);
  const valuation = toDateAtMidnight(valuationDate);
  return Boolean(maturity && valuation && maturity < valuation);
};

const getDaysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

export const addMonthsClamped = (value, months, anchorDay, preserveEndOfMonth) => {
  const date = toDateAtMidnight(value);
  if (!date || !Number.isInteger(months)) return null;

  const sourceLastDay = getDaysInMonth(date.getFullYear(), date.getMonth());
  const shouldPreserveEndOfMonth = preserveEndOfMonth ?? date.getDate() === sourceLastDay;
  const requestedDay = anchorDay ?? date.getDate();
  const monthIndex = date.getFullYear() * 12 + date.getMonth() + months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const targetLastDay = getDaysInMonth(targetYear, targetMonth);
  const targetDay = shouldPreserveEndOfMonth
    ? targetLastDay
    : Math.min(requestedDay, targetLastDay);

  return new Date(targetYear, targetMonth, targetDay);
};

export const isSupportedTreasuryType = (tradeOrType) => {
  const type = typeof tradeOrType === 'string' ? tradeOrType : tradeOrType?.type;
  return SUPPORTED_TREASURY_TYPES.has(type);
};

export const isCouponTreasury = (trade) => trade?.type === 't-note' || trade?.type === 't-bond';

export const getCouponDates = (trade) => {
  if (!isCouponTreasury(trade)) return [];
  const maturityDate = toDateAtMidnight(trade.maturityDate);
  const frequency = Number(trade.couponFrequency);
  if (!maturityDate || !Number.isInteger(frequency) || frequency <= 0 || 12 % frequency !== 0) return [];

  const intervalMonths = 12 / frequency;
  const anchorDay = maturityDate.getDate();
  const preserveEndOfMonth = anchorDay === getDaysInMonth(maturityDate.getFullYear(), maturityDate.getMonth());
  const dates = [];

  for (let index = 0; index <= frequency * 50; index += 1) {
    dates.push(addMonthsClamped(maturityDate, -index * intervalMonths, anchorDay, preserveEndOfMonth));
  }

  return dates.filter(Boolean).sort((a, b) => a - b);
};

const isSameDate = (date1, date2) => formatDateOnly(date1) === formatDateOnly(date2);

export const getPreviousNextCouponDates = (trade, settlementDate) => {
  if (!isCouponTreasury(trade)) return null;
  const settlement = toDateAtMidnight(settlementDate);
  const maturityDate = toDateAtMidnight(trade.maturityDate);
  if (!settlement || !maturityDate || settlement >= maturityDate) return null;

  const schedule = getCouponDates(trade);
  for (let index = 0; index < schedule.length - 1; index += 1) {
    const previous = schedule[index];
    const next = schedule[index + 1];
    if (isSameDate(previous, settlement) || (previous < settlement && settlement < next)) {
      return { previous, next };
    }
  }
  return null;
};

export const calculateAccruedInterestPer100 = (trade, settlementDate) => {
  if (!isCouponTreasury(trade)) return 0;
  const couponRate = Number(trade.couponRate);
  const frequency = Number(trade.couponFrequency);
  if (!Number.isFinite(couponRate) || couponRate <= 0 || !Number.isFinite(frequency) || frequency <= 0) return 0;

  const couponWindow = getPreviousNextCouponDates(trade, settlementDate);
  if (!couponWindow) return 0;
  const daysAccrued = calculateForwardDaysBetween(couponWindow.previous, settlementDate);
  const daysInPeriod = calculateForwardDaysBetween(couponWindow.previous, couponWindow.next);
  if (daysAccrued == null || daysAccrued < 0 || !daysInPeriod || daysInPeriod <= 0) return 0;
  return (couponRate / frequency) * (daysAccrued / daysInPeriod);
};

const getStoredAccruedInterest = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export const getPurchaseAccruedInterestPer100 = (trade) => {
  if (!isCouponTreasury(trade)) return 0;
  return getStoredAccruedInterest(trade.accruedInterestPer100)
    ?? calculateAccruedInterestPer100(trade, trade.tradeDate);
};

export const getCloseAccruedInterestPer100 = (trade) => {
  if (!isCouponTreasury(trade)) return 0;
  return getStoredAccruedInterest(trade.closeAccruedInterestPer100)
    ?? calculateAccruedInterestPer100(trade, trade.closeDate);
};

export const getQuotedAccruedInterestPer100 = (trade, settlementDate) => {
  if (!isCouponTreasury(trade)) return 0;
  return getStoredAccruedInterest(trade.accruedInterestPer100)
    ?? calculateAccruedInterestPer100(trade, settlementDate);
};

export const getDirtyPrice = (cleanPrice, accruedInterestPer100) => {
  const clean = Number(cleanPrice);
  const accrued = Number(accruedInterestPer100);
  if (!Number.isFinite(clean) || clean <= 0) return null;
  return clean + (Number.isFinite(accrued) ? accrued : 0);
};

export const getMarketYTMFromCurve = (curve, years) => {
  if (!curve?.points?.length || !Number.isFinite(years) || years <= 0) return null;
  const points = [...curve.points].sort((a, b) => a.years - b.years);
  if (years <= points[0].years) return points[0].yield;
  if (years >= points[points.length - 1].years) return points[points.length - 1].yield;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    if (years >= current.years && years <= next.years) {
      const ratio = (years - current.years) / (next.years - current.years);
      return current.yield + ratio * (next.yield - current.yield);
    }
  }
  return null;
};

export const getTBillInvestmentYield = (price, days) => {
  if (!Number.isFinite(price) || price <= 0 || !days || days <= 0) return null;
  return ((100 - price) / price) * (365 / days) * 100;
};

export const yieldToPrice = (trade, marketYieldPercent, valuationDate) => {
  if (!isSupportedTreasuryType(trade) || !Number.isFinite(marketYieldPercent)) return null;
  const maturityDate = toDateAtMidnight(trade.maturityDate);
  const valuation = toDateAtMidnight(valuationDate);
  const daysToMaturity = calculateForwardDaysBetween(valuation, maturityDate);
  if (!maturityDate || !valuation || !daysToMaturity || daysToMaturity <= 0) return null;

  const yieldDecimal = marketYieldPercent / 100;
  if (trade.type === 't-bill') return 100 / (1 + yieldDecimal * (daysToMaturity / 365));
  if (!isCouponTreasury(trade)) return null;

  const frequency = Number(trade.couponFrequency) || 2;
  const couponPerPeriod = (Number(trade.couponRate) || 0) / frequency;
  const yieldPerPeriod = yieldDecimal / frequency;
  if (yieldPerPeriod <= -1) return null;

  const paymentDates = getCouponDates(trade).filter((date) => date > valuation);
  if (paymentDates.length === 0) return null;
  const daysPerPeriod = 365.25 / frequency;
  let price = 0;
  for (const paymentDate of paymentDates) {
    const days = calculateForwardDaysBetween(valuation, paymentDate);
    price += couponPerPeriod / Math.pow(1 + yieldPerPeriod, days / daysPerPeriod);
  }
  const maturityDays = calculateForwardDaysBetween(valuation, maturityDate);
  price += 100 / Math.pow(1 + yieldPerPeriod, maturityDays / daysPerPeriod);
  return price;
};

export const solveYTMFromPrice = (trade, targetPrice, valuationDate) => {
  if (!isSupportedTreasuryType(trade) || !Number.isFinite(targetPrice) || targetPrice <= 0) return null;
  const daysToMaturity = calculateForwardDaysBetween(valuationDate, trade.maturityDate);
  if (!daysToMaturity || daysToMaturity <= 0) return null;
  if (trade.type === 't-bill') return getTBillInvestmentYield(targetPrice, daysToMaturity);

  let low = -50;
  let high = 100;
  let lowPrice = yieldToPrice(trade, low, valuationDate);
  let highPrice = yieldToPrice(trade, high, valuationDate);
  if (lowPrice == null || highPrice == null) return null;

  while (lowPrice < targetPrice && low > -95) {
    low -= 25;
    lowPrice = yieldToPrice(trade, low, valuationDate);
    if (lowPrice == null) return null;
  }
  while (highPrice > targetPrice && high < 500) {
    high += 100;
    highPrice = yieldToPrice(trade, high, valuationDate);
    if (highPrice == null) return null;
  }
  if (targetPrice > lowPrice || targetPrice < highPrice) return null;

  for (let index = 0; index < 80; index += 1) {
    const mid = (low + high) / 2;
    const price = yieldToPrice(trade, mid, valuationDate);
    if (price == null) return null;
    if (price > targetPrice) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
};

export const getTradeYTM = (trade, valuationDate) => {
  if (!isSupportedTreasuryType(trade)) return null;
  const cleanPrice = Number(trade.currentMarketPrice);
  const daysToMaturity = calculateForwardDaysBetween(valuationDate, trade.maturityDate);
  if (!Number.isFinite(cleanPrice) || cleanPrice <= 0 || !daysToMaturity || daysToMaturity <= 0) return null;
  if (trade.type === 't-bill') return getTBillInvestmentYield(cleanPrice, daysToMaturity);

  const accruedInterestPer100 = calculateAccruedInterestPer100(trade, valuationDate);
  const dirtyPrice = getDirtyPrice(cleanPrice, accruedInterestPer100);
  return solveYTMFromPrice(trade, dirtyPrice, valuationDate);
};

export const generateAllCoupons = (trade) => {
  if (!isCouponTreasury(trade) || !trade.couponFrequency || !trade.couponRate) return [];
  const tradeDate = toDateAtMidnight(trade.tradeDate);
  const maturityDate = toDateAtMidnight(trade.maturityDate);
  const endDate = trade.status === 'closed' ? toDateAtMidnight(trade.closeDate) : maturityDate;
  if (!tradeDate || !endDate) return [];

  return getCouponDates(trade)
    .filter((date) => date > tradeDate && date <= endDate)
    .map((date) => ({
      id: `${trade.id}-${formatDateOnly(date)}`,
      tradeId: trade.id,
      cusip: trade.cusip || trade.type.toUpperCase(),
      date,
      dateStr: formatDateOnly(date),
      amount: ((Number(trade.faceValue) * (Number(trade.couponRate) / 100)) / Number(trade.couponFrequency))
        * (trade.side === 'sell' ? -1 : 1),
      isShort: trade.side === 'sell',
    }))
    .sort((a, b) => a.date - b.date);
};

export const makeTradeId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export const toFiniteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export const normalizeTradeForStorage = (trade) => {
  const cleanPrice = toFiniteNumber(trade.cleanPrice);
  const status = trade.status === 'closed' ? 'closed' : 'active';
  const isBill = trade.type === 't-bill';
  const normalized = {
    ...trade,
    id: String(trade.id || makeTradeId()),
    cusip: String(trade.cusip || '').trim(),
    type: trade.type,
    side: trade.side,
    tradeDate: trade.tradeDate,
    maturityDate: trade.maturityDate,
    faceValue: toFiniteNumber(trade.faceValue),
    cleanPrice,
    couponRate: isBill ? 0 : toFiniteNumber(trade.couponRate),
    commission: toFiniteNumber(trade.commission),
    couponFrequency: isBill ? 0 : toFiniteNumber(trade.couponFrequency, 2),
    currentMarketPrice: toFiniteNumber(trade.currentMarketPrice, cleanPrice),
    status,
  };

  const purchaseAccrued = getStoredAccruedInterest(trade.accruedInterestPer100);
  if (isCouponTreasury(normalized) && purchaseAccrued != null) normalized.accruedInterestPer100 = purchaseAccrued;
  else delete normalized.accruedInterestPer100;

  if (status === 'closed') {
    normalized.closeDate = trade.closeDate || trade.maturityDate;
    normalized.closePrice = toFiniteNumber(trade.closePrice, normalized.currentMarketPrice);
    normalized.closeCommission = toFiniteNumber(trade.closeCommission);
    const closeAccrued = getStoredAccruedInterest(trade.closeAccruedInterestPer100);
    if (isCouponTreasury(normalized) && closeAccrued != null) normalized.closeAccruedInterestPer100 = closeAccrued;
    else delete normalized.closeAccruedInterestPer100;
  }
  return normalized;
};

const getPositionMultiplier = (trade) => trade.side === 'sell' ? -1 : 1;

const getPurchaseDirtyPrice = (trade) => getDirtyPrice(
  toFiniteNumber(trade.cleanPrice),
  getPurchaseAccruedInterestPer100(trade),
);

export const calculateActiveUnrealizedPnl = (trade, valuationDate) => {
  if (!isSupportedTreasuryType(trade)) return null;
  const purchaseDirtyPrice = getPurchaseDirtyPrice(trade);
  const currentDirtyPrice = getDirtyPrice(
    toFiniteNumber(trade.currentMarketPrice, trade.cleanPrice),
    calculateAccruedInterestPer100(trade, valuationDate),
  );
  if (purchaseDirtyPrice == null || currentDirtyPrice == null) return null;
  return (((currentDirtyPrice - purchaseDirtyPrice) * toFiniteNumber(trade.faceValue)) / 100)
    * getPositionMultiplier(trade) - toFiniteNumber(trade.commission);
};

export const calculateClosedTradePricePnl = (trade) => {
  if (!isSupportedTreasuryType(trade)) return null;
  const purchaseDirtyPrice = getPurchaseDirtyPrice(trade);
  const closeDirtyPrice = getDirtyPrice(
    toFiniteNumber(trade.closePrice, trade.currentMarketPrice),
    getCloseAccruedInterestPer100(trade),
  );
  if (purchaseDirtyPrice == null || closeDirtyPrice == null) return null;
  return (((closeDirtyPrice - purchaseDirtyPrice) * toFiniteNumber(trade.faceValue)) / 100)
    * getPositionMultiplier(trade)
    - toFiniteNumber(trade.commission)
    - toFiniteNumber(trade.closeCommission);
};

export const calculateMaturedTradePricePnl = (trade) => {
  if (!isSupportedTreasuryType(trade)) return null;
  const purchaseDirtyPrice = getPurchaseDirtyPrice(trade);
  if (purchaseDirtyPrice == null) return null;
  return (((100 - purchaseDirtyPrice) * toFiniteNumber(trade.faceValue)) / 100)
    * getPositionMultiplier(trade) - toFiniteNumber(trade.commission);
};

export const calculateTradePricePnl = (trade, valuationDate) => {
  if (trade.status === 'closed') return calculateClosedTradePricePnl(trade);
  if (isMatured(trade.maturityDate, valuationDate)) return calculateMaturedTradePricePnl(trade);
  return calculateActiveUnrealizedPnl(trade, valuationDate);
};
