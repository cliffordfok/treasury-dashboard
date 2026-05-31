import assert from 'node:assert/strict';
import { parseCsvText } from './csvParser.js';
import {
  DUPLICATE_STATUS,
  PREVIEW_STATUS,
  buildImportPreview,
  buildImportPreviewFromCsvText,
} from './importPreviewCalculations.js';

const equal = (actual, expected, message) => assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);

const quotedCsv = 'Date,Description,Amount\r\n05/31/2026,"Dividend, VOO","$70.00"\r\n05/31/2026,,\r\n';
const parsed = parseCsvText(quotedCsv);
equal(parsed.headers.length, 3, 'parser header count');
equal(parsed.rows[0].Description, 'Dividend, VOO', 'parser quoted comma');
equal(parsed.rows[1].Description, '', 'parser empty cell');

const stockCsv = [
  'Trade Date,Action,Symbol,Quantity,Price,Commission,Fees,Description',
  '05/31/2026,Buy,VOO,2,680,0,0,Bought VOO',
].join('\n');
let preview = buildImportPreviewFromCsvText(stockCsv);
equal(preview.csvType, 'stock_activity', 'stock activity csv type');
equal(preview.rows[0].targetDraft, 'Stock Trade', 'stock row target');
equal(preview.rows[0].status, PREVIEW_STATUS.OK, 'stock row status');
equal(preview.rows[0].draft.side, 'buy', 'stock draft side');

const cashCsv = [
  'Date,Type,Symbol,Gross Amount,Withholding Tax,Net Amount,Description',
  '05/31/2026,Dividend,VOO,100,30,70,Qualified dividend',
].join('\n');
preview = buildImportPreviewFromCsvText(cashCsv);
equal(preview.csvType, 'cash_activity', 'cash activity csv type');
equal(preview.rows[0].targetDraft, 'Cash Movement', 'cash row target');
equal(preview.rows[0].draft.type, 'dividend', 'cash draft type');

const positionsCsv = [
  'Date,Symbol,Quantity,Cost Basis,Market Value,Description',
  '05/31/2026,SGOV,10,1000,1001.25,SGOV position',
].join('\n');
preview = buildImportPreviewFromCsvText(positionsCsv);
equal(preview.csvType, 'positions', 'positions csv type');
equal(preview.rows[0].targetDraft, 'Reconciliation Holding', 'position target');
equal(preview.rows[0].draft.symbol, 'SGOV', 'position draft symbol');

const unknownCsv = ['Foo,Bar', 'abc,123'].join('\n');
preview = buildImportPreviewFromCsvText(unknownCsv);
equal(preview.csvType, 'unknown', 'unknown csv type');
equal(preview.rows[0].status, PREVIEW_STATUS.ERROR, 'unknown row error');

preview = buildImportPreviewFromCsvText(
  [
    'Trade Date,Action,Symbol,Quantity,Price,Commission,Fees,Description',
    '05/31/2026,Buy,VOO,2,680,0,0,Bought VOO',
    '05/31/2026,Buy,VOO,2,680,0,0,Bought VOO',
  ].join('\n'),
);
equal(preview.rows[0].duplicateStatus, DUPLICATE_STATUS.NEW, 'first duplicate row new');
equal(preview.rows[1].duplicateStatus, DUPLICATE_STATUS.DUPLICATE_IN_FILE, 'second duplicate row in file');
equal(preview.rows[1].status, PREVIEW_STATUS.DUPLICATE, 'duplicate row status');

const existingPreview = buildImportPreview({
  headers: ['Trade Date', 'Action', 'Symbol', 'Quantity', 'Price', 'Commission', 'Fees'],
  rows: [{ 'Trade Date': '05/31/2026', Action: 'Buy', Symbol: 'VOO', Quantity: '2', Price: '680', Commission: '0', Fees: '0' }],
  existingStockTrades: [{ accountId: 'firstrade', side: 'buy', tradeDate: '2026-05-31', symbol: 'VOO', quantity: 2, price: 680, commission: 0, fees: 0 }],
});
equal(existingPreview.rows[0].duplicateStatus, DUPLICATE_STATUS.DUPLICATE_EXISTING, 'existing duplicate row');
equal(existingPreview.summary.duplicateRows, 1, 'duplicate summary count');

const invalidPreview = buildImportPreviewFromCsvText(
  ['Trade Date,Action,Symbol,Quantity,Price', '05/31/2026,Buy,VOO,0,680'].join('\n'),
);
equal(invalidPreview.rows[0].status, PREVIEW_STATUS.ERROR, 'invalid stock row error');
assert.ok(invalidPreview.rows[0].errors.some((error) => error.includes('quantity')), 'invalid row includes quantity error');

const firstradeSampleCsv = [
  'Symbol,Quantity,Price,Action,Description,TradeDate,SettledDate,Interest,Amount,Commission,Fee,CUSIP,RecordType',
  'NVDA,-19.00,190.3,SELL,NVIDIA CORP UNSOLICITED,2026-01-05,2026-01-06,0.00,3615.7,0.00,0.00,67066G104,Trade',
  'ONDS,20.00,12.28,BUY,ONDAS HOLDINGS INC COMMON STOCK UNSOLICITED,2026-01-05,2026-01-06,0.00,-245.6,0.00,0.00,68236H204,Trade',
  'GOOGL,0.00,,Dividend,ALPHABET INC CASH DIV NON-RES TAX WITHHELD $0.50,2026-03-16,2026-03-16,0.00,1.68,0.00,0.00,02079K305,Financial',
  ',0.00,,Interest,INTEREST ON CREDIT BALANCE,2026-01-16,2026-01-16,0.00,0.36,0.00,0.00,,Financial',
  ',0.00,,Other,Wire Funds Received FedRef 123,2026-01-23,2026-01-23,0.00,2175.00,0.00,0.00,,Financial',
  ',0.00,,Other,TFR from Type 1,2026-01-02,2026-01-02,0.00,0.11,0.00,0.00,,Financial',
  'VOO,0.22762,,Other,VANGUARD S&P 500 ETF REIN @ 590.5769 REC 03/27/26 PAY 03/31/26,2026-03-31,2026-03-31,0.00,-134.43,0.00,0.00,922908363,Financial',
].join('\n');

preview = buildImportPreviewFromCsvText(firstradeSampleCsv);
equal(preview.csvType, 'stock_activity', 'actual Firstrade mixed activity csv type');
equal(preview.summary.totalRows, 7, 'actual Firstrade total rows');
equal(preview.summary.okRows, 6, 'actual Firstrade ok rows');
equal(preview.summary.ignoredRows, 1, 'actual Firstrade ignored rows');
equal(preview.summary.errorRows, 0, 'actual Firstrade error rows');
equal(preview.summary.importableRows, 6, 'actual Firstrade importable rows');
equal(preview.rows[0].draft.side, 'sell', 'actual Firstrade sell side');
equal(preview.rows[0].draft.quantity, 19, 'actual Firstrade sell quantity absolute');
equal(preview.rows[1].draft.side, 'buy', 'actual Firstrade buy side');
equal(preview.rows[2].draft.type, 'dividend', 'actual Firstrade dividend type');
equal(preview.rows[2].draft.withholdingTax, 0.5, 'actual Firstrade dividend withholding extracted');
equal(preview.rows[2].draft.grossAmount, 2.18, 'actual Firstrade dividend gross inferred');
equal(preview.rows[3].draft.type, 'interest', 'actual Firstrade interest type');
equal(preview.rows[4].draft.type, 'deposit', 'actual Firstrade wire deposit type');
equal(preview.rows[5].status, PREVIEW_STATUS.IGNORED, 'actual Firstrade internal transfer ignored');
equal(preview.rows[6].activityType, 'dividend_reinvestment', 'actual Firstrade reinvestment activity type');
equal(preview.rows[6].draft.side, 'buy', 'actual Firstrade reinvestment buy side');
equal(preview.rows[6].draft.price, 590.5769, 'actual Firstrade reinvestment price parsed from description');
