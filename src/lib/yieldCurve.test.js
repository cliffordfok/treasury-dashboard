import { describe, expect, it } from 'vitest';
import {
  FRED_CURVE_SERIES,
  getFredPricingSignature,
  normalizeYieldCurve,
  shouldUpdateFredEstimate,
} from './yieldCurve.js';

const makeCurve = (date = '2026-09-03') => ({
  updatedAt: '2026-09-04',
  points: FRED_CURVE_SERIES.map((point, index) => ({
    ...point,
    yield: 4 + (index / 10),
    date,
  })),
});

describe('FRED yield curve validation', () => {
  it('accepts exactly one complete observation date and corrects legacy updatedAt', () => {
    const curve = normalizeYieldCurve(makeCurve());
    expect(curve.points).toHaveLength(11);
    expect(curve.observationDate).toBe('2026-09-03');
    expect(curve.updatedAt).toBe('2026-09-03');
  });

  it('rejects an incomplete curve', () => {
    const curve = makeCurve();
    curve.points.pop();
    expect(() => normalizeYieldCurve(curve)).toThrow('不完整');
  });

  it('rejects mixed observation dates', () => {
    const curve = makeCurve();
    curve.points[0].date = '2026-09-02';
    expect(() => normalizeYieldCurve(curve)).toThrow('觀察日期不一致');
  });
});

describe('FRED theoretical estimate freshness', () => {
  const trade = {
    type: 't-note',
    maturityDate: '2030-07-15',
    couponRate: 4,
    couponFrequency: 2,
  };

  it('never replaces a newer estimate with an older cached curve', () => {
    const pricedTrade = {
      ...trade,
      fredEstimatedAt: '2026-09-04',
      fredPricingSignature: getFredPricingSignature(trade),
    };
    expect(shouldUpdateFredEstimate(pricedTrade, '2026-09-03')).toBe(false);
  });

  it('reprices changed bond terms even on the same observation date', () => {
    const pricedTrade = {
      ...trade,
      couponRate: 5,
      fredEstimatedAt: '2026-09-03',
      fredPricingSignature: getFredPricingSignature(trade),
    };
    expect(shouldUpdateFredEstimate(pricedTrade, '2026-09-03')).toBe(true);
  });

  it('does not move the estimate date backwards when terms have changed', () => {
    const pricedTrade = {
      ...trade,
      couponRate: 5,
      fredEstimatedAt: '2026-09-04',
      fredPricingSignature: getFredPricingSignature(trade),
    };
    expect(shouldUpdateFredEstimate(pricedTrade, '2026-09-03')).toBe(false);
  });
});
