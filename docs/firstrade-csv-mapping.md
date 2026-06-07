# Firstrade CSV Mapping

## Scope

The CSV import layer maps Firstrade rows into previewable, validated drafts before any write step.

It supports writing only:

- `stockTrades`
- `cashMovements`

It does not add stock quote APIs, AI analysis, or Treasury calculation changes.

## Mapping Helpers

- `src/features/import/firstradeMapping.js`
- `src/features/import/firstradeMapping.test.mjs`

## Supported Draft Targets

- Stock trade draft for `stockTrades`
- Cash movement draft for `cashMovements`
- Position rows as preview-only informational rows

Importable drafts may include:

- `source: "firstrade_csv"`
- `importFingerprint`

These fields are used for preview, duplicate detection, and import auditability.

## Supported CSV Types

`detectFirstradeCsvType(headers)` can classify:

- `stock_activity`
- `cash_activity`
- `positions`
- `unknown`

`positions` rows are intentionally ignored by confirm import. They can be shown in preview for user awareness, but they are not written to Firestore.

## Header Aliases

### Stock Trade Fields

- Date / Trade Date / Transaction Date
- Action / Activity / Type
- Symbol / Ticker
- Quantity / Shares
- Price
- Commission
- Fees
- Amount / Net Cash Amount
- Description

### Cash Movement Fields

- Date
- Type / Activity
- Symbol
- Amount
- Gross Amount
- Net Amount
- Withholding Tax
- Description

### Positions Fields

- Symbol
- Quantity / Shares
- Cost Basis
- Market Value
- Price
- Description

## Classification Rules

`classifyFirstradeActivity(row)` uses activity/type and description text.

Supported activity classes:

- `stock_trade_buy`
- `stock_trade_sell`
- `dividend_reinvestment`
- `dividend`
- `withholding_tax`
- `interest`
- `fee`
- `deposit`
- `withdrawal`
- `adjustment`
- `ignored`
- `unknown`

Internal transfers such as `TFR from Type`, `TFR to Type`, `XFER CASH TO MARGIN`, and `XFER MARGIN TO CASH` are ignored.

## Parsers

### Dates

Supported:

- `YYYY-MM-DD`
- Unambiguous `MM/DD/YYYY`, for example `05/31/2026`

Ambiguous slash dates such as `05/06/2026` return `null`. `DD/MM/YYYY` is not guessed.

### Numbers

Supported:

- `1,234.56`
- `$1,234.56`
- `-123.45`
- `(123.45)` as `-123.45`
- Empty value as `null`

## Draft Conversion

### Stock Trade Draft

`toStockTradeDraft(mappedRow)` returns:

- `accountId: "firstrade"`
- `symbol`
- `side: "buy" | "sell"`
- `tradeDate`
- `tradeTime`
- `quantity`
- `price`
- `commission`
- `fees`
- `currency: "USD"`
- `notes`
- `source: "firstrade_csv"`
- `importFingerprint`

### Cash Movement Draft

`toCashMovementDraft(mappedRow)` returns:

- `accountId: "firstrade"`
- `type`
- `date`
- `symbol`
- `currency: "USD"`
- `amount`
- `grossAmount`
- `withholdingTax`
- `netAmount`
- `notes`
- `source: "firstrade_csv"`
- `importFingerprint`

Withholding tax and fee drafts store positive `amount` values because Cash Ledger impact logic applies the negative sign based on `type`.

### Position Rows

Position CSV rows are preview-only. They are shown as `Position Row`, marked ignored, and are not importable.

## Validation

`validateImportedDraft(draft)` returns:

```js
{
  ok: boolean,
  errors: string[],
  warnings: string[]
}
```

Rules include:

- Stock `symbol` must be uppercase and present
- Stock `quantity` must be greater than 0
- Stock `price` must be 0 or greater
- Cash `amount` must be numeric
- Dates must be `YYYY-MM-DD`
- Unknown activity types produce warnings
- Missing required fields produce errors

## Duplicate Detection

`buildImportFingerprint(draft)` creates stable strings.

Stock trade fingerprint fields:

- `accountId`
- `side`
- `tradeDate`
- `symbol`
- `quantity`
- `price`
- `commission`
- `fees`

Cash movement fingerprint fields:

- `accountId`
- `type`
- `date`
- `symbol`
- `amount`
- `grossAmount`
- `withholdingTax`
- `notes`

Position rows do not create import fingerprints because they are not importable.

## Confirm Import

Confirm import writes only `OK + NEW` rows whose target is:

- `Stock Trade`
- `Cash Movement`

The following rows remain preview-only and are skipped:

- Position rows
- Ignored rows
- Duplicate rows
- Warning rows
- Error rows
- Rows before the configured tracking start date
