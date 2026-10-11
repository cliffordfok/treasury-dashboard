import {
  calculateAccruedInterestPer100,
  calculateForwardDaysBetween,
  getCouponDates,
  getMarketYTMFromCurve,
  isCouponTreasury,
  isValidISODate,
  solveYTMFromPrice,
  toDateAtMidnight,
  yieldToPrice,
} from './treasuryMath.js';

// Bump when the pricing formula changes so stored estimates are recalculated.
const FRED_PRICING_MODEL_VERSION = 'zero-curve-v1';
const HALF_YEARS_TO_30Y = 60;
const discountFactorCache = new WeakMap();

export const FRED_CURVE_SERIES = [
  { id: 'DGS1MO', years: 0.0833 },
  { id: 'DGS3MO', years: 0.25 },
  { id: 'DGS6MO', years: 0.5 },
  { id: 'DGS1', years: 1 },
  { id: 'DGS2', years: 2 },
  { id: 'DGS3', years: 3 },
  { id: 'DGS5', years: 5 },
  { id: 'DGS7', years: 7 },
  { id: 'DGS10', years: 10 },
  { id: 'DGS20', years: 20 },
  { id: 'DGS30', years: 30 },
];

export const buildCommonYieldCurve = (seriesPayloads) => {
  if (!seriesPayloads || typeof seriesPayloads !== 'object') {
    throw new Error('FRED 回應集合無效');
  }

  const valuesBySeries = new Map();
  for (const expected of FRED_CURVE_SERIES) {
    const observations = seriesPayloads[expected.id]?.observations;
    if (!Array.isArray(observations) || observations.length === 0) {
      throw new Error(`FRED ${expected.id} 缺少觀察值`);
    }

    const valuesByDate = new Map();
    for (const observation of observations) {
      const yieldValue = Number(observation?.value);
      if (
        isValidISODate(observation?.date)
        && observation?.value !== '.'
        && Number.isFinite(yieldValue)
        && yieldValue > -100
      ) {
        valuesByDate.set(observation.date, yieldValue);
      }
    }
    if (valuesByDate.size === 0) {
      throw new Error(`FRED ${expected.id} 沒有可用觀察值`);
    }
    valuesBySeries.set(expected.id, valuesByDate);
  }

  const firstSeriesDates = [...valuesBySeries.get(FRED_CURVE_SERIES[0].id).keys()];
  const commonDate = firstSeriesDates
    .filter((date) => FRED_CURVE_SERIES.every(({ id }) => valuesBySeries.get(id).has(date)))
    .sort((left, right) => right.localeCompare(left))[0];

  if (!commonDate) {
    throw new Error('FRED 11 個年期沒有共同觀察日');
  }

  return normalizeYieldCurve({
    points: FRED_CURVE_SERIES.map(({ id, years }) => ({
      id,
      years,
      yield: valuesBySeries.get(id).get(commonDate),
      date: commonDate,
    })),
    observationDate: commonDate,
    updatedAt: commonDate,
  });
};

export const normalizeYieldCurve = (data) => {
  if (!data || typeof data !== 'object' || !Array.isArray(data.points)) {
    throw new Error('yield-curve.json 格式無效');
  }

  const pointById = new Map();
  for (const point of data.points) {
    if (!point || typeof point !== 'object' || pointById.has(point.id)) {
      throw new Error('FRED 收益率曲線包含重複或無效項目');
    }
    pointById.set(point.id, point);
  }

  if (pointById.size !== FRED_CURVE_SERIES.length) {
    throw new Error(`FRED 收益率曲線不完整：需要 ${FRED_CURVE_SERIES.length} 點`);
  }

  const points = FRED_CURVE_SERIES.map((expected) => {
    const point = pointById.get(expected.id);
    const years = Number(point?.years);
    const yieldValue = Number(point?.yield);
    if (
      !point
      || !Number.isFinite(years)
      || Math.abs(years - expected.years) > 0.00001
      || !Number.isFinite(yieldValue)
      || yieldValue <= -100
      || !isValidISODate(point.date)
    ) {
      throw new Error(`FRED 收益率曲線項目無效：${expected.id}`);
    }
    return { id: expected.id, years: expected.years, yield: yieldValue, date: point.date };
  });

  const observationDates = [...new Set(points.map((point) => point.date))];
  if (observationDates.length !== 1) {
    throw new Error('FRED 收益率曲線的觀察日期不一致');
  }

  const observationDate = observationDates[0];
  return {
    ...data,
    points,
    observationDate,
    // Keep the legacy field aligned with the actual market observation date.
    updatedAt: observationDate,
  };
};

export const getFredPricingSignature = (trade) => [
  FRED_PRICING_MODEL_VERSION,
  trade?.type || '',
  trade?.maturityDate || '',
  Number(trade?.couponRate) || 0,
  Number(trade?.couponFrequency) || 0,
].join('|');

// CMT yields are par yields: a bond paying the n-year yield as its semiannual
// coupon prices at par. Solving those par bonds in order gives the discount
// factor for every half-year to 30 years (index k = k / 2 years).
export const bootstrapDiscountFactors = (curve) => {
  if (discountFactorCache.has(curve)) return discountFactorCache.get(curve);
  const factors = [1];
  let annuity = 0;
  for (let step = 1; step <= HALF_YEARS_TO_30Y; step += 1) {
    const parYield = getMarketYTMFromCurve(curve, step / 2);
    if (parYield == null) return null;
    const coupon = parYield / 200;
    const factor = (1 - coupon * annuity) / (1 + coupon);
    if (!(factor > 0)) return null;
    factors.push(factor);
    annuity += factor;
  }
  discountFactorCache.set(curve, factors);
  return factors;
};

export const getDiscountFactor = (curve, years) => {
  if (!Number.isFinite(years) || years < 0) return null;
  // Up to six months the curve is a bill (money-market) yield.
  if (years <= 0.5) {
    const billYield = getMarketYTMFromCurve(curve, Math.max(years, 1 / 365));
    return billYield == null ? null : 1 / (1 + (billYield / 100) * years);
  }
  const factors = bootstrapDiscountFactors(curve);
  if (!factors) return null;
  // Log-linear between grid points (constant forward rate), extended past 30 years.
  const position = years * 2;
  const index = Math.min(Math.floor(position), HALF_YEARS_TO_30Y - 1);
  const weight = position - index;
  return Math.exp(Math.log(factors[index]) * (1 - weight) + Math.log(factors[index + 1]) * weight);
};

const priceCouponBondFromCurve = (trade, curve, valuationDate) => {
  const frequency = Number(trade.couponFrequency) || 2;
  const coupon = (Number(trade.couponRate) || 0) / frequency;
  const payments = getCouponDates(trade).filter((date) => date > valuationDate);
  if (payments.length === 0) return null;
  let dirtyPrice = 0;
  for (const [index, paymentDate] of payments.entries()) {
    const factor = getDiscountFactor(curve, calculateForwardDaysBetween(valuationDate, paymentDate) / 365.25);
    if (factor == null) return null;
    dirtyPrice += (coupon + (index === payments.length - 1 ? 100 : 0)) * factor;
  }
  return dirtyPrice;
};

export const getFredTheoreticalEstimate = (trade, curve) => {
  const observationDate = curve?.observationDate;
  if (!curve?.points?.length || !isValidISODate(observationDate)) return null;
  const valuationDate = toDateAtMidnight(observationDate);
  const daysToMaturity = calculateForwardDaysBetween(valuationDate, trade?.maturityDate);
  if (!daysToMaturity || daysToMaturity <= 0) return null;

  // Bills discount at the curve's bill yield; coupon bonds discount each cash
  // flow on the bootstrapped zero curve, which captures the coupon effect a
  // single par yield misses for deep-discount or premium bonds.
  let dirtyPrice;
  let marketYield;
  if (isCouponTreasury(trade)) {
    dirtyPrice = priceCouponBondFromCurve(trade, curve, valuationDate);
    marketYield = dirtyPrice == null ? null : solveYTMFromPrice(trade, dirtyPrice, valuationDate);
  } else {
    marketYield = getMarketYTMFromCurve(curve, daysToMaturity / 365.25);
    dirtyPrice = marketYield == null ? null : yieldToPrice(trade, marketYield, valuationDate);
  }
  if (!Number.isFinite(dirtyPrice) || dirtyPrice <= 0 || marketYield == null) return null;
  const cleanPrice = dirtyPrice - calculateAccruedInterestPer100(trade, valuationDate);
  if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) return null;
  return { cleanPrice, marketYield, observationDate };
};

export const hasCurrentFredEstimate = (trade) => (
  Number.isFinite(Number(trade?.fredEstimatedPrice))
  && Number(trade.fredEstimatedPrice) > 0
  && isValidISODate(trade?.fredEstimatedAt)
  && trade?.fredPricingSignature === getFredPricingSignature(trade)
);

export const shouldUpdateFredEstimate = (trade, observationDate) => {
  if (!isValidISODate(observationDate)) return false;
  const hasCurrentTerms = trade?.fredPricingSignature === getFredPricingSignature(trade);
  const estimatedAt = isValidISODate(trade?.fredEstimatedAt) ? trade.fredEstimatedAt : '';
  if (!hasCurrentTerms) return !estimatedAt || estimatedAt <= observationDate;
  if (estimatedAt && estimatedAt > observationDate) return false;
  return !estimatedAt || estimatedAt < observationDate;
};
