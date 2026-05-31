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
