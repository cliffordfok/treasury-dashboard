import assert from 'node:assert/strict';
import {
  buildImportFingerprint,
  classifyFirstradeActivity,
  detectFirstradeCsvType,
  mapFirstradeRow,
  normalizeHeader,
  parseFirstradeDate,
  parseFirstradeNumber,
  toCashMovementDraft,
  toReconciliationHoldingDraft,
  toStockTradeDraft,
  validateImportedDraft,
} from './firstradeMapping.js';

const equal = (actual, expected, message) => assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);

equal(normalizeHeader(' Trade Date '), 'trade date', 'normalize trims and lowercases');
equal(normalizeHeader('Net Amount'), 'net amount', 'normalize net amount');
equal(normalizeHeader('Transaction_Type'), 'transaction type', 'normalize separators');

near(parseFirstradeNumber('$1,234.56'), 1234.56, 'currency number');
near(parseFirstradeNumber('(123.45)'), -123.45, 'parentheses negative number');
equal(parseFirstradeNumber(''), null, 'empty number returns null');

equal(parseFirstradeDate('2026-05-31'), '2026-05-31', 'iso date');
equal(parseFirstradeDate('05/31/2026'), '2026-05-31', 'us slash date');
equal(parseFirstradeDate('05/06/2026'), null, 'ambiguous slash date');
equal(parseFirstradeDate('31/05/2026'), null, 'dd/mm date not silently guessed');

equal(
  detectFirstradeCsvType(['Trade Date', 'Action', 'Symbol', 'Quantity', 'Price', 'Commission']),
  'stock_activity',
  'detect stock activity',
);
equal(detectFirstradeCsvType(['Date', 'Type', 'Amount', 'Description']), 'cash_activity', 'detect cash activity');
equal(detectFirstradeCsvType(['Symbol', 'Quantity', 'Cost Basis', 'Market Value']), 'positions', 'detect positions');
equal(detectFirstradeCsvType(['Date', 'Symbol', 'Quantity', 'Cost Basis', 'Market Value']), 'positions', 'detect dated positions');
equal(detectFirstradeCsvType(['Foo', 'Bar']), 'unknown', 'detect unknown');

equal(classifyFirstradeActivity({ Activity: 'Buy', Description: 'Bought VOO' }), 'stock_trade_buy', 'classify buy');
equal(classifyFirstradeActivity({ Activity: 'Sell', Description: 'Sold VOO' }), 'stock_trade_sell', 'classify sell');
equal(classifyFirstradeActivity({ Activity: 'Dividend', Description: 'Cash dividend VOO' }), 'dividend', 'classify dividend');
equal(classifyFirstradeActivity({ Activity: 'Tax', Description: 'Foreign tax withheld' }), 'withholding_tax', 'classify withholding tax');
equal(classifyFirstradeActivity({ Activity: 'Interest', Description: 'Credit interest' }), 'interest', 'classify interest');
equal(classifyFirstradeActivity({ Activity: 'Fee', Description: 'ADR fee' }), 'fee', 'classify fee');
equal(classifyFirstradeActivity({ Activity: 'Something Else' }), 'unknown', 'classify unknown');

const buyMapped = mapFirstradeRow(
  {
    'Trade Date': '05/31/2026',
    Action: 'Buy',
    Symbol: 'voo',
    Quantity: '2',
    Price: '$680.00',
    Commission: '$0.00',
    Fees: '$0.05',
    Description: 'Bought VOO',
  },
  'stock_activity',
);
const buyDraft = toStockTradeDraft(buyMapped);
equal(buyDraft.accountId, 'firstrade', 'stock draft account');
equal(buyDraft.symbol, 'VOO', 'stock draft symbol uppercase');
equal(buyDraft.side, 'buy', 'stock draft side');
equal(buyDraft.tradeDate, '2026-05-31', 'stock draft date');
near(buyDraft.quantity, 2, 'stock draft quantity');
near(buyDraft.price, 680, 'stock draft price');
near(buyDraft.fees, 0.05, 'stock draft fees');
equal(buyDraft.source, 'firstrade_csv', 'stock draft source');
equal(validateImportedDraft(buyDraft).ok, true, 'stock draft validates');

const sellDraft = toStockTradeDraft(mapFirstradeRow({ Date: '2026-05-31', Type: 'Sell', Ticker: 'NVDA', Shares: '1', Price: '700' }, 'stock_activity'));
equal(sellDraft.side, 'sell', 'sell draft side');
equal(validateImportedDraft(sellDraft).ok, true, 'sell draft validates');

const dividendDraft = toCashMovementDraft(
  mapFirstradeRow(
    {
      Date: '05/31/2026',
      Type: 'Dividend',
      Symbol: 'VOO',
      'Gross Amount': '$100.00',
      'Withholding Tax': '$30.00',
      'Net Amount': '$70.00',
      Description: 'Qualified dividend',
    },
    'cash_activity',
  ),
);
equal(dividendDraft.type, 'dividend', 'dividend cash type');
near(dividendDraft.amount, 70, 'dividend amount');
near(dividendDraft.grossAmount, 100, 'dividend gross');
near(dividendDraft.withholdingTax, 30, 'dividend withholding tax');
equal(validateImportedDraft(dividendDraft).ok, true, 'dividend draft validates');

const taxDraft = toCashMovementDraft(mapFirstradeRow({ Date: '2026-05-31', Type: 'Foreign Tax Withheld', Symbol: 'VOO', Amount: '($30.00)' }, 'cash_activity'));
equal(taxDraft.type, 'withholding_tax', 'withholding cash type');
near(taxDraft.amount, 30, 'withholding amount is stored positive');

const feeDraft = toCashMovementDraft(mapFirstradeRow({ Date: '2026-05-31', Type: 'ADR Fee', Symbol: 'ADR', Amount: '($2.18)' }, 'cash_activity'));
equal(feeDraft.type, 'fee', 'fee cash type');
near(feeDraft.amount, 2.18, 'fee amount positive');

const interestDraft = toCashMovementDraft(mapFirstradeRow({ Date: '2026-05-31', Type: 'Interest', Amount: '$4.50' }, 'cash_activity'));
equal(interestDraft.type, 'interest', 'interest cash type');
near(interestDraft.amount, 4.5, 'interest amount');

const holdingDraft = toReconciliationHoldingDraft(
  mapFirstradeRow(
    { Date: '05/31/2026', Symbol: 'sgov', Quantity: '10', 'Cost Basis': '$1,000.00', 'Market Value': '$1,001.25', Description: 'SGOV position' },
    'positions',
  ),
);
equal(holdingDraft.symbol, 'SGOV', 'holding symbol uppercase');
equal(holdingDraft.date, '2026-05-31', 'holding date');
near(holdingDraft.brokerQuantity, 10, 'holding quantity');
near(holdingDraft.brokerCostBasis, 1000, 'holding cost basis');
near(holdingDraft.brokerMarketValue, 1001.25, 'holding market value');
equal(validateImportedDraft(holdingDraft).ok, true, 'holding draft validates');

const firstFingerprint = buildImportFingerprint(buyDraft);
const secondFingerprint = buildImportFingerprint({ ...buyDraft });
equal(firstFingerprint, secondFingerprint, 'same stock row has stable fingerprint');
assert.ok(firstFingerprint.includes('stock|firstrade|buy|2026-05-31|voo'), 'stock fingerprint includes key fields');

const invalidDraft = { ...buyDraft, quantity: 0 };
const invalidResult = validateImportedDraft(invalidDraft);
equal(invalidResult.ok, false, 'invalid quantity fails');
assert.ok(invalidResult.errors.some((error) => error.includes('quantity')), 'invalid quantity has error');
