# Stock Quotes

股票報價功能目前已停用，日後再處理。

## Current Status

The Portfolio Dashboard is temporarily focused on ledger-based data:

- Stock Ledger positions
- Remaining cost
- Realized P&L
- Stock trade cash impact
- Cash Ledger balance
- Reconciliation snapshots
- Treasury metrics

The UI no longer shows stock quote controls, automatic quote refresh, current price, stock market value, stock unrealized P&L, missing quote counts, proxy setup warnings, or static quote cache warnings.

## Preserved Data

Existing Firestore data under:

```text
users/{uid}/stockPrices/{symbol}
```

is intentionally preserved. No migration or deletion is required.

## Disabled Paths

These paths are not used by the active UI:

- automatic quote refresh
- Yahoo Finance quote proxy
- static quote cache
- manual price entry
- quote-derived market value
- quote-derived unrealized P&L

The old serverless endpoint and quote cache modules can remain in the repository for future reference, but they are not called by the app while quote features are disabled.

The public static cache files are intentionally empty/disabled:

- `public/stock-quotes/latest.json`
- `public/stock-quotes/symbols.json`

They should not be treated as active quote data in the current app.

## Re-enabling Later

If quote features are revisited later, prefer doing it behind an explicit feature flag, for example:

```text
VITE_ENABLE_STOCK_QUOTES=true
```

The default should remain disabled unless the quote provider and deployment path are settled.
