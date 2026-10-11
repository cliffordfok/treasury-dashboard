import { describe, expect, it } from 'vitest';
import { calculatePortfolioMetrics } from './portfolio.js';
import { getTradeYTM } from './treasuryMath.js';

const makeBill = (overrides = {}) => ({
  id: 'bill-1',
  type: 't-bill',
  side: 'buy',
  tradeDate: '2026-07-09',
  maturityDate: '2027-01-07',
  faceValue: 100000,
  cleanPrice: 98,
  currentMarketPrice: 98,
  couponRate: 0,
  couponFrequency: 0,
  commission: 0,
  status: 'active',
  ...overrides,
});

describe('portfolio yield', () => {
  const valuationDate = '2026-10-11';

  it('matches the single-position yield for a long-only portfolio', () => {
    const bill = makeBill();
    const { totalWeightYTM } = calculatePortfolioMetrics({ activeTrades: [bill], valuationDate });
    expect(totalWeightYTM).toBeCloseTo(getTradeYTM(bill, valuationDate), 10);
  });

  it('subtracts the carry paid on short positions instead of adding it', () => {
    const long = makeBill({ id: 'long', cleanPrice: 98, currentMarketPrice: 98 });
    const short = makeBill({ id: 'short', side: 'sell', cleanPrice: 97.5, currentMarketPrice: 97.5 });
    const longYield = getTradeYTM(long, valuationDate);
    const shortYield = getTradeYTM(short, valuationDate);
    const { totalWeightYTM } = calculatePortfolioMetrics({ activeTrades: [long, short], valuationDate });

    expect(shortYield).toBeGreaterThan(longYield);
    expect(totalWeightYTM).toBeLessThan(0);
    expect(totalWeightYTM).toBeCloseTo((longYield * 98 - shortYield * 97.5) / (98 + 97.5), 10);
  });

  it('returns no yield when there is no priced active position', () => {
    expect(calculatePortfolioMetrics({ activeTrades: [], valuationDate }).totalWeightYTM).toBeNull();
  });

  it('nets clean and accrued market value by position direction', () => {
    const long = makeBill({ id: 'long', faceValue: 2000, currentMarketPrice: 99 });
    const short = makeBill({ id: 'short', side: 'sell', faceValue: 1000, currentMarketPrice: 99 });
    const metrics = calculatePortfolioMetrics({
      activeTrades: [long, short],
      receivedCoupons: [{ amount: 20 }, { amount: -5 }],
      valuationDate,
    });
    expect(metrics.totalMarketValue).toBeCloseTo(990, 10);
    expect(metrics.totalFullMarketValue).toBeCloseTo(990, 10);
    expect(metrics.totalRealizedPnL).toBe(15);
  });
});
