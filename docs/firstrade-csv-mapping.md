# Firstrade CSV Mapping

## Phase 3A Scope

Phase 3A builds the pure mapping and validation layer for future Firstrade CSV import work.

It does not import rows into Firestore. It does not add upload UI, CSV parser integration, stock quote APIs, AI analysis, reconciliation automation, or Treasury calculation changes.

The mapping helpers live in:

- `src/features/import/firstradeMapping.js`
- `src/features/import/firstradeMapping.test.mjs`

## Design

Firstrade CSV rows are converted into normalized intermediate objects first. Those intermediate rows can then be validated and previewed before any future write step.

Supported draft targets:

- Stock trade draft for future `stockTrades`
- Cash movement draft for future `cashMovements`
- Reconciliation holding draft for future snapshot holdings

Each draft may include:

- `source: "firstrade_csv"`
- `importFingerprint`

These fields are intended for preview and duplicate detection. Phase 3A does not write them to Firestore.

## Supported CSV Types

`detectFirstradeCsvType(headers)` can classify:

- `stock_activity`
- `cash_activity`
- `positions`
- `unknown`

Unknown files should be shown for manual review in a future preview UI instead of being silently imported.

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
- `dividend`
- `withholding_tax`
- `interest`
- `fee`
- `deposit`
- `withdrawal`
- `adjustment`
- `unknown`

Withholding tax is checked before dividend so descriptions such as `foreign tax withheld` do not become dividend rows.

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

Withholding tax and fee drafts store positive `amount` values because existing Cash Ledger impact logic applies the negative sign based on `type`.

### Reconciliation Holding Draft

`toReconciliationHoldingDraft(mappedRow)` returns:

- `symbol`
- `brokerQuantity`
- `brokerCostBasis`
- `brokerMarketValue`
- `notes`
- `accountId: "firstrade"`
- `source: "firstrade_csv"`
- `importFingerprint`

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

Position fingerprint fields:

- `accountId`
- `date`
- `symbol`
- `brokerQuantity`
- `brokerCostBasis`
- `brokerMarketValue`

## Phase 3B Recommendation

Phase 3B should add a preview UI and import confirmation flow:

1. Upload CSV file.
2. Parse rows in-browser.
3. Detect CSV type.
4. Show mapped drafts with validation status.
5. Detect duplicates by comparing `importFingerprint`.
6. Let the user confirm selected rows.
7. Only then write to `stockTrades`, `cashMovements`, or a reconciliation snapshot.

Phase 3B should still avoid stock quote APIs and AI analysis unless requested separately.
