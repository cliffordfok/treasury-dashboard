import { describe, expect, it } from 'vitest';
import {
  buildCommonYieldCurve,
  FRED_CURVE_SERIES,
  getFredPricingSignature,
  hasCurrentFredEstimate,
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
  const makeSeriesPayloads = () => Object.fromEntries(FRED_CURVE_SERIES.map(({ id }, index) => [
    id,
    {
      observations: [
        { date: '2026-09-04', value: id === 'DGS30' ? '.' : String(4 + index / 10) },
        { date: '2026-09-03', value: String(3.9 + index / 10) },
        { date: '2026-09-02', value: String(3.8 + index / 10) },
      ],
    },
  ]));

  it('selects the latest complete common date instead of mixing observations', () => {
    const curve = buildCommonYieldCurve(makeSeriesPayloads());
    expect(curve.observationDate).toBe('2026-09-03');
    expect(new Set(curve.points.map((point) => point.date))).toEqual(new Set(['2026-09-03']));
  });

  it('fails closed when the 11 series have no common date', () => {
    const payloads = makeSeriesPayloads();
    payloads.DGS30.observations = [{ date: '2026-09-01', value: '4.5' }];
    expect(() => buildCommonYieldCurve(payloads)).toThrow('沒有共同觀察日');
  });

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
    expect(hasCurrentFredEstimate(pricedTrade)).toBe(false);
  });

  it('only exposes a complete estimate calculated for the current bond terms', () => {
    const pricedTrade = {
      ...trade,
      fredEstimatedPrice: 99.125,
      fredEstimatedAt: '2026-09-04',
      fredPricingSignature: getFredPricingSignature(trade),
    };
    expect(hasCurrentFredEstimate(pricedTrade)).toBe(true);
    expect(hasCurrentFredEstimate({ ...pricedTrade, maturityDate: '2031-07-15' })).toBe(false);
    expect(hasCurrentFredEstimate({ ...pricedTrade, fredEstimatedPrice: null })).toBe(false);
  });
});
