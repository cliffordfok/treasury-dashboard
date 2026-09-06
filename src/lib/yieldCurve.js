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
  trade?.type || '',
  trade?.maturityDate || '',
  Number(trade?.couponRate) || 0,
  Number(trade?.couponFrequency) || 0,
].join('|');

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
