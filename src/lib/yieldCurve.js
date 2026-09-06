import { isValidISODate } from './treasuryMath.js';

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
  trade?.type || '',
  trade?.maturityDate || '',
  Number(trade?.couponRate) || 0,
  Number(trade?.couponFrequency) || 0,
].join('|');

export const shouldUpdateFredEstimate = (trade, observationDate) => {
  if (!isValidISODate(observationDate)) return false;
  const estimatedAt = isValidISODate(trade?.fredEstimatedAt) ? trade.fredEstimatedAt : '';
  if (estimatedAt && estimatedAt > observationDate) return false;
  const hasCurrentTerms = trade?.fredPricingSignature === getFredPricingSignature(trade);
  return !hasCurrentTerms || !estimatedAt || estimatedAt < observationDate;
};
