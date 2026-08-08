import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  calculateAccruedInterestPer100,
  calculateClosedTradePricePnl,
  calculateForwardDaysBetween,
  calculateMaturedTradePricePnl,
  formatDateOnly,
  generateAllCoupons,
  getCouponDates,
  getPurchaseAccruedInterestPer100,
  isSupportedTreasuryType,
  isValidISODate,
  normalizeTradeForStorage,
  toDateAtMidnight,
} from './treasuryMath.js';

const couponTrade = {
  id: 'note-1',
  type: 't-note',
  side: 'buy',
  tradeDate: '2026-01-15',
  maturityDate: '2030-07-15',
  faceValue: 1000,
  cleanPrice: 100,
  currentMarketPrice: 100,
  couponRate: 4,
  couponFrequency: 2,
  commission: 1,
  status: 'active',
};

describe('calendar-safe date handling', () => {
  it('parses ISO dates as the same local calendar date', () => {
    const parsed = toDateAtMidnight('2026-08-08');
    expect(formatDateOnly(parsed)).toBe('2026-08-08');
  });

  it('rejects impossible ISO dates', () => {
    expect(isValidISODate('2026-02-28')).toBe(true);
    expect(isValidISODate('2026-02-31')).toBe(false);
    expect(isValidISODate('2026-13-01')).toBe(false);
  });

  it('does not coerce missing dates to the Unix epoch', () => {
    expect(toDateAtMidnight(null)).toBeNull();
    expect(toDateAtMidnight(undefined)).toBeNull();
    expect(toDateAtMidnight('')).toBeNull();
  });

  it('counts calendar days without daylight-saving drift', () => {
    expect(calculateForwardDaysBetween('2026-03-08', '2026-03-09')).toBe(1);
  });

  it('clamps month-end dates instead of overflowing into March', () => {
    expect(formatDateOnly(addMonthsClamped('2026-08-31', -6))).toBe('2026-02-28');
  });

  it('preserves month-end coupon schedules from the maturity anchor', () => {
    const dates = getCouponDates({ ...couponTrade, maturityDate: '2026-08-31' }).map(formatDateOnly);
    expect(dates).toContain('2026-02-28');
    expect(dates).toContain('2025-08-31');
    expect(dates).not.toContain('2026-03-03');
  });
});

describe('accrued interest and PnL', () => {
  it('uses stored accrued interest only for the purchase settlement', () => {
    const trade = { ...couponTrade, accruedInterestPer100: 1.25 };
    expect(getPurchaseAccruedInterestPer100(trade)).toBe(1.25);
    expect(calculateAccruedInterestPer100(trade, '2026-04-15')).not.toBe(1.25);
  });

  it('resets accrued interest to zero on a coupon date', () => {
    expect(calculateAccruedInterestPer100(couponTrade, '2026-07-15')).toBe(0);
  });

  it('includes purchase and close accrued interest in realized PnL', () => {
    const trade = {
      ...couponTrade,
      accruedInterestPer100: 1,
      status: 'closed',
      closeDate: '2026-05-15',
      closePrice: 101,
      closeAccruedInterestPer100: 2,
      closeCommission: 2,
    };
    expect(calculateClosedTradePricePnl(trade)).toBeCloseTo(17, 8);
  });

  it('deducts purchase accrued interest from maturity settlement PnL', () => {
    const trade = { ...couponTrade, cleanPrice: 99, accruedInterestPer100: 1 };
    expect(calculateMaturedTradePricePnl(trade)).toBeCloseTo(-1, 8);
  });
});

describe('unsupported TIPS protection', () => {
  const tipsTrade = { ...couponTrade, type: 'tips' };

  it('does not claim TIPS calculation support', () => {
    expect(isSupportedTreasuryType(tipsTrade)).toBe(false);
    expect(generateAllCoupons(tipsTrade)).toEqual([]);
    expect(calculateClosedTradePricePnl({ ...tipsTrade, status: 'closed' })).toBeNull();
  });
});

describe('trade normalization', () => {
  it('stores T-Bills without coupon fields', () => {
    const trade = normalizeTradeForStorage({
      ...couponTrade,
      type: 't-bill',
      couponRate: 4,
      couponFrequency: 2,
      accruedInterestPer100: 1,
    });
    expect(trade.couponRate).toBe(0);
    expect(trade.couponFrequency).toBe(0);
    expect(trade).not.toHaveProperty('accruedInterestPer100');
  });
});

describe('coupon generation', () => {
  it('uses deterministic calendar-date identifiers', () => {
    const coupons = generateAllCoupons({
      ...couponTrade,
      tradeDate: '2026-01-15',
      maturityDate: '2027-01-15',
    });
    expect(coupons.map((coupon) => coupon.dateStr)).toEqual(['2026-07-15', '2027-01-15']);
    expect(coupons.map((coupon) => coupon.id)).toEqual(['note-1-2026-07-15', 'note-1-2027-01-15']);
  });
});
