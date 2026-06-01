import assert from 'node:assert/strict';
import { buildImportPreviewFromCsvText } from './importPreviewCalculations.js';
import { buildConfirmImportPlan } from './importConfirmCalculations.js';

const equal = (actual, expected, message) => assert.equal(actual, expected, `${message}: expected ${expected}, got ${actual}`);

const mixedCsv = [
  'Symbol,Quantity,Price,Action,Description,TradeDate,SettledDate,Interest,Amount,Commission,Fee,CUSIP,RecordType',
  'VOO,2,680,BUY,VANGUARD S&P 500 ETF,2026-05-01,2026-05-04,0,-1360,0,0,922908363,Trade',
  'VOO,-1,700,SELL,VANGUARD S&P 500 ETF,2026-05-02,2026-05-05,0,698.95,1,0.05,922908363,Trade',
  'VOO,0,,Dividend,VANGUARD CASH DIV NON-RES TAX WITHHELD $30.00,2026-05-03,2026-05-03,0,70,0,0,922908363,Financial',
  ',0,,Interest,INTEREST ON CREDIT BALANCE,2026-05-04,2026-05-04,0,1.25,0,0,,Financial',
  ',0,,Other,TFR from Type 1,2026-05-05,2026-05-05,0,0.10,0,0,,Financial',
].join('\n');

let preview = buildImportPreviewFromCsvText(mixedCsv);
let plan = buildConfirmImportPlan({ previewRows: preview.rows, userId: 'user-1' });

equal(plan.summary.stockTradeRows, 2, 'imports stock trade rows');
equal(plan.summary.cashMovementRows, 2, 'imports cash movement rows');
equal(plan.summary.skippedIgnoredRows, 1, 'skips ignored internal transfer rows');
equal(plan.summary.importableRows, 4, 'importable row count');
equal(plan.summary.buyRows, 1, 'buy row count');
equal(plan.summary.sellRows, 1, 'sell row count');
equal(plan.summary.dividendRows, 1, 'dividend row count');
equal(plan.summary.interestRows, 1, 'interest row count');
equal(plan.stockTrades[0].source, 'firstrade_csv', 'stock payload source');
assert.ok(plan.stockTrades[0].importFingerprint, 'stock payload importFingerprint');
equal(plan.cashMovements[0].source, 'firstrade_csv', 'cash payload source');
assert.ok(plan.cashMovements[0].importFingerprint, 'cash payload importFingerprint');
equal(plan.cashMovements[0].grossAmount, 100, 'dividend gross amount inferred');
equal(plan.cashMovements[0].withholdingTax, 30, 'dividend withholding preserved');

preview = buildImportPreviewFromCsvText(
  [
    'Trade Date,Action,Symbol,Quantity,Price,Commission,Fees',
    '05/31/2026,Buy,VOO,2,680,0,0',
    '05/31/2026,Buy,VOO,2,680,0,0',
  ].join('\n'),
);
plan = buildConfirmImportPlan({ previewRows: preview.rows, userId: 'user-1' });
equal(plan.summary.stockTradeRows, 1, 'imports first in-file duplicate only');
equal(plan.summary.skippedDuplicateRows, 1, 'skips in-file duplicate');

preview = buildImportPreviewFromCsvText(['Trade Date,Action,Symbol,Quantity,Price', '05/31/2026,Buy,VOO,0,680'].join('\n'));
plan = buildConfirmImportPlan({ previewRows: preview.rows, userId: 'user-1' });
equal(plan.summary.importableRows, 0, 'does not import error rows');
equal(plan.summary.skippedErrorRows, 1, 'counts error skips');

preview = buildImportPreviewFromCsvText(
  ['Date,Symbol,Quantity,Cost Basis,Market Value', '05/31/2026,VOO,10,1000,1200'].join('\n'),
);
plan = buildConfirmImportPlan({ previewRows: preview.rows, userId: 'user-1' });
equal(plan.summary.importableRows, 0, 'does not import positions rows');
equal(plan.summary.skippedPositionRows, 1, 'counts position skips');

preview = buildImportPreviewFromCsvText(['Trade Date,Action,Symbol,Quantity,Price', '05/31/2026,Buy,VOO,2,680'].join('\n'));
plan = buildConfirmImportPlan({
  previewRows: preview.rows,
  userId: 'user-1',
  existingStockTrades: [{ accountId: 'firstrade', side: 'buy', tradeDate: '2026-05-31', symbol: 'VOO', quantity: 2, price: 680, commission: 0, fees: 0 }],
});
equal(plan.summary.importableRows, 0, 'does not import existing duplicate rows');
equal(plan.summary.skippedDuplicateRows, 1, 'counts existing duplicate skip');

preview = buildImportPreviewFromCsvText(
  [
    'Trade Date,Action,Symbol,Quantity,Price,Commission,Fees',
    '2026-05-30,Buy,VOO,1,650,0,0',
    '2026-05-31,Buy,VOO,1,660,0,0',
    '2026-06-01,Buy,VOO,1,670,0,0',
  ].join('\n'),
  { trackingStartDate: '2026-05-31' },
);
plan = buildConfirmImportPlan({ previewRows: preview.rows, userId: 'user-1', trackingStartDate: '2026-05-31' });
equal(plan.summary.stockTradeRows, 2, 'confirm imports start-date and later rows');
equal(plan.summary.skippedBeforeStartDateRows, 1, 'confirm skips rows before tracking start date');
equal(plan.summary.importableRows, 2, 'confirm excludes before-start rows from importable count');
assert.ok(plan.skippedRows.some((row) => row.reason === 'before_start_date'), 'confirm records before-start skip reason');

preview = buildImportPreviewFromCsvText(
  ['Trade Date,Action,Symbol,Quantity,Price,Commission,Fees', '2026-05-30,Buy,VOO,1,650,0,0'].join('\n'),
);
plan = buildConfirmImportPlan({ previewRows: preview.rows, userId: 'user-1', trackingStartDate: '2026-05-31' });
equal(plan.summary.importableRows, 0, 'confirm re-applies tracking start date even without preview filter');
equal(plan.summary.skippedBeforeStartDateRows, 1, 'confirm recheck counts before-start skip');
