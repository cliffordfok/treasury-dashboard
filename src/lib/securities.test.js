import { describe, expect, it } from 'vitest';
import {
  buildSecuritiesIndex,
  isValidCusip,
  normalizeAuctionRows,
  securityToTradeTerms,
  validateSecuritiesFeed,
} from './securities.js';

// Appends the standard check digit to an 8-character base (fixtures only).
const withCheckDigit = (base) => {
  for (let digit = 0; digit <= 9; digit += 1) {
    if (isValidCusip(`${base}${digit}`)) return `${base}${digit}`;
  }
  throw new Error('no check digit');
};

describe('CUSIP validation', () => {
  it('accepts real CUSIPs and rejects a wrong check digit', () => {
    expect(isValidCusip('037833100')).toBe(true); // Apple
    expect(isValidCusip('594918104')).toBe(true); // Microsoft
    expect(isValidCusip(' 037833100 ')).toBe(true);
    expect(isValidCusip('037833101')).toBe(false);
    expect(isValidCusip('91282NOTE')).toBe(false);
    expect(isValidCusip('12345')).toBe(false);
  });
});

describe('Fiscal Data auction rows', () => {
  const note = withCheckDigit('91282CLN');
  const bill = withCheckDigit('912797RT');
  const tips = withCheckDigit('91282CMR');

  it('maps bills, notes and bonds and accepts either coupon field name', () => {
    const securities = normalizeAuctionRows([
      { cusip: note, security_type: 'Note', security_term: '3-Year', issue_date: '2025-11-17', maturity_date: '2028-11-15', int_rate: '4.125' },
      { cusip: bill, security_type: 'Bill', security_term: '26-Week', issue_date: '2026-08-20', maturity_date: '2027-02-18', int_rate: 'null' },
      { cusip: withCheckDigit('912810TV'), security_type: 'Bond', security_term: '20-Year', issue_date: '2025-05-15', maturity_date: '2045-05-15', interest_rate: '4.625' },
      { cusip: tips, security_type: 'TIPS', security_term: '10-Year', issue_date: '2026-07-15', maturity_date: '2036-07-15', int_rate: '1.875' },
    ]);
    expect(securities.map((security) => [security.type, security.couponRate])).toEqual([
      ['t-bill', 0],
      ['t-note', 4.125],
      ['t-bond', 4.625],
    ]);
  });

  it('leaves out TIPS and FRNs even when listed as notes or bonds', () => {
    const securities = normalizeAuctionRows([
      { cusip: note, security_type: 'Note', maturity_date: '2028-11-15', int_rate: '4.125', inflation_index_security: 'No', floating_rate: 'No' },
      { cusip: tips, security_type: 'Note', maturity_date: '2036-07-15', int_rate: '1.875', inflation_index_security: 'Yes', floating_rate: 'No' },
      { cusip: withCheckDigit('91282CNA'), security_type: 'Note', maturity_date: '2028-07-31', int_rate: '0', inflation_index_security: 'No', floating_rate: 'Yes' },
    ]);
    expect(securities.map((security) => security.cusip)).toEqual([note]);
  });

  it('merges reopenings into one record with the original issue date', () => {
    const [security] = normalizeAuctionRows([
      { cusip: note, security_type: 'Note', security_term: '2-Year 10-Month', issue_date: '2026-01-15', maturity_date: '2028-11-15', int_rate: '4.125' },
      { cusip: note, security_type: 'Note', security_term: '3-Year', issue_date: '2025-11-17', maturity_date: '2028-11-15', int_rate: '4.125' },
    ]);
    expect(security.issueDate).toBe('2025-11-17');
  });

  it('refuses rows whose terms disagree for the same CUSIP', () => {
    expect(() => normalizeAuctionRows([
      { cusip: note, security_type: 'Note', maturity_date: '2028-11-15', int_rate: '4.125' },
      { cusip: note, security_type: 'Note', maturity_date: '2028-11-15', int_rate: '4.25' },
    ])).toThrow(note);
  });

  it('skips notes without a usable coupon instead of guessing zero', () => {
    expect(normalizeAuctionRows([
      { cusip: note, security_type: 'Note', maturity_date: '2028-11-15', int_rate: 'null' },
    ])).toEqual([]);
  });
});

describe('securities feed', () => {
  const makeFeed = (count) => ({
    generatedAt: '2026-10-13',
    securities: Array.from({ length: count }, (_, index) => ({
      cusip: withCheckDigit(`9128${String(index).padStart(4, '0')}`),
      type: ['t-bill', 't-note', 't-bond'][index % 3],
      maturityDate: '2030-05-15',
      couponRate: index % 3 === 0 ? 0 : 4,
    })),
  });

  it('rejects incomplete or invalid feeds', () => {
    expect(() => validateSecuritiesFeed({})).toThrow();
    expect(() => validateSecuritiesFeed(makeFeed(5))).toThrow('不足');
    expect(() => validateSecuritiesFeed(makeFeed(5), { minimum: 1 })).not.toThrow();
    const broken = makeFeed(3);
    broken.securities[0].cusip = '91282NOTE';
    expect(() => validateSecuritiesFeed(broken, { minimum: 1 })).toThrow('無效');
  });

  it('looks up trade terms by CUSIP', () => {
    const feed = validateSecuritiesFeed(makeFeed(3), { minimum: 1 });
    const index = buildSecuritiesIndex(feed);
    const [bill, noteSecurity] = feed.securities;
    expect(securityToTradeTerms(index.get(bill.cusip))).toEqual({
      cusip: bill.cusip, type: 't-bill', maturityDate: '2030-05-15', couponRate: 0, couponFrequency: 0,
    });
    expect(securityToTradeTerms(index.get(noteSecurity.cusip)).couponFrequency).toBe(2);
  });
});
