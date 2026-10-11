import { describe, expect, it } from 'vitest';
import {
  calculateAccruedInterestPer100,
  calculateForwardDaysBetween,
  getMarketYTMFromCurve,
  yieldToPrice,
} from './treasuryMath.js';
import {
  bootstrapDiscountFactors,
  buildCommonYieldCurve,
  FRED_CURVE_SERIES,
  getFredPricingSignature,
  getFredTheoreticalEstimate,
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

  it('prices deterministically at the curve observation date', () => {
    const curve = normalizeYieldCurve(makeCurve('2026-09-03'));
    const estimate = getFredTheoreticalEstimate({
      ...trade,
      tradeDate: '2026-01-15',
      faceValue: 1000,
      cleanPrice: 100,
      currentMarketPrice: 100,
      side: 'buy',
      commission: 0,
      status: 'active',
    }, curve);

    expect(estimate.observationDate).toBe('2026-09-03');
    // Zero-curve pricing; matches an independent bootstrap to 1e-10.
    expect(estimate.cleanPrice).toBeCloseTo(98.0880666934, 9);
    // Yield implied by the zero-curve price (street convention).
    expect(estimate.marketYield).toBeCloseTo(4.54381797, 7);
  });

  it('invalidates estimates created by the previous pricing model', () => {
    expect(shouldUpdateFredEstimate({
      ...trade,
      fredEstimatedAt: '2026-09-03',
      fredPricingSignature: 't-note|2030-07-15|4|2',
    }, '2026-09-03')).toBe(true);
    expect(shouldUpdateFredEstimate({
      ...trade,
      fredEstimatedAt: '2026-09-03',
      fredPricingSignature: 'curve-date-v2|t-note|2030-07-15|4|2',
    }, '2026-09-03')).toBe(true);
    expect(shouldUpdateFredEstimate({
      ...trade,
      fredEstimatedAt: '2026-09-03',
      fredPricingSignature: 'curve-date-v3|t-note|2030-07-15|4|2',
    }, '2026-09-03')).toBe(true);
  });
});

describe('bootstrapped zero curve', () => {
  const flatCurve = normalizeYieldCurve({
    points: FRED_CURVE_SERIES.map((point) => ({ ...point, yield: 4, date: '2026-09-03' })),
  });
  const upwardCurve = normalizeYieldCurve(makeCurve('2026-09-03'));

  it('turns a flat par curve into the same semiannual zero rate', () => {
    const factors = bootstrapDiscountFactors(flatCurve);
    for (const step of [1, 2, 10, 60]) {
      expect(factors[step]).toBeCloseTo(1.02 ** -step, 12);
    }
  });

  it('reprices every par bond on the half-year grid at 100', () => {
    const factors = bootstrapDiscountFactors(upwardCurve);
    let annuity = 0;
    for (let step = 1; step <= 60; step += 1) {
      annuity += factors[step];
      const coupon = getMarketYTMFromCurve(upwardCurve, step / 2) / 200;
      expect(coupon * annuity + factors[step]).toBeCloseTo(1, 12);
    }
  });

  it('prices low-coupon long bonds below the single par-yield shortcut', () => {
    const lowCoupon = { type: 't-bond', maturityDate: '2050-05-15', couponRate: 1.25, couponFrequency: 2 };
    const zeroCurvePrice = getFredTheoreticalEstimate(lowCoupon, upwardCurve).cleanPrice;
    // Independent bootstrap reference.
    expect(zeroCurvePrice).toBeCloseTo(48.4230927858, 9);

    const years = calculateForwardDaysBetween('2026-09-03', lowCoupon.maturityDate) / 365.25;
    const parYieldShortcut = yieldToPrice(lowCoupon, getMarketYTMFromCurve(upwardCurve, years), '2026-09-03')
      - calculateAccruedInterestPer100(lowCoupon, '2026-09-03');
    // The coupon effect is material here: about 0.4 points on this curve.
    expect(parYieldShortcut - zeroCurvePrice).toBeGreaterThan(0.3);
  });
});
