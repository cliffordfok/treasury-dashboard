# Stock Quote Cache

The Portfolio Dashboard uses a static stock quote cache for current price, market value, and unrealized P&L estimates.

## Source

- Provider: `yahoo_finance2`
- Saved quote source: `yahoo_finance2_quote_cache`
- Quote type: `delayed_or_regular_market`
- Yahoo does not provide an official public quote API for this use case.
- `yahoo-finance2` is an unofficial wrapper and may break if Yahoo changes its responses.
- No API key is required.
- Quotes are for portfolio value estimates only and are not trading advice.

The browser must not call Yahoo Finance directly. The project only uses `yahoo-finance2` in Node.js through GitHub Actions.

## Dynamic Symbols From Firestore

The preferred quote symbol source is Firestore:

```text
users/{QUOTE_USER_ID}/stockTrades/{tradeId}
```

When both `FIREBASE_SERVICE_ACCOUNT_JSON` and `QUOTE_USER_ID` are configured, the updater reads that user's Stock Ledger trades, reuses the same Stock Ledger position calculation, and keeps only symbols with remaining shares greater than zero.

This supports:

- `buy`
- `sell`
- `opening_position`
- uppercase symbols
- deduped symbols
- maximum 50 symbols

Newly added holdings can be quoted after the next `Update Stock Quotes` workflow run without editing `symbols.json`.

## Static Fallback

If either `FIREBASE_SERVICE_ACCOUNT_JSON` or `QUOTE_USER_ID` is missing, the updater falls back to:

```text
public/stock-quotes/symbols.json
```

Example:

```json
{
  "symbols": ["VOO", "GOOGL", "MU", "NVDA", "GLDM"],
  "provider": "yahoo_finance2",
  "note": "Used by GitHub Actions quote cache updater"
}
```

## Cache File

The generated cache lives at:

```text
public/stock-quotes/latest.json
```

Response shape:

```json
{
  "provider": "yahoo_finance2",
  "quoteType": "delayed_or_regular_market",
  "updatedAt": "2026-06-06T22:30:00.000Z",
  "symbolsSource": "firestore_stock_trades",
  "quotes": [
    {
      "symbol": "VOO",
      "price": 693.12,
      "currency": "USD",
      "asOf": "2026-06-06T20:00:00.000Z",
      "previousClose": 690.25,
      "change": 2.87,
      "changePercent": 0.42,
      "source": "yahoo_finance2_quote_cache",
      "quoteType": "delayed_or_regular_market"
    }
  ],
  "warnings": [],
  "errors": []
}
```

If Firestore is configured but no active holdings are found, `quotes` can be empty with a warning.

## GitHub Actions

The workflow is:

```text
.github/workflows/update-stock-quotes.yml
```

It supports:

- `workflow_dispatch` manual runs.
- Scheduled runs at Hong Kong-friendly times.
- `contents: write` so it can commit an updated `latest.json` back to `main`.
- Firestore symbol discovery via `FIREBASE_SERVICE_ACCOUNT_JSON` and `QUOTE_USER_ID`.
- Static fallback via `symbols.json`.

The script is:

```text
scripts/update-stock-quotes.mjs
```

It validates symbols, fetches quotes with `yahoo-finance2`, writes per-symbol errors, and updates `public/stock-quotes/latest.json`.

## Required GitHub Settings

To make future newly added stocks appear automatically, add:

```text
FIREBASE_SERVICE_ACCOUNT_JSON
```

Use a GitHub repository secret. The value can be raw Firebase service account JSON or base64-encoded JSON. Do not commit this JSON to the repo.

Also add:

```text
QUOTE_USER_ID
```

This can be a repository secret or variable. It should be the Firebase uid whose `stockTrades` should drive the quote cache.

## Manual Update

To update quotes manually:

1. Open the repository on GitHub.
2. Go to Actions.
3. Select `Update Stock Quotes`.
4. Click `Run workflow`.
5. Wait for the workflow to commit `Update stock quote cache`.
6. Let GitHub Pages redeploy from `main`.

You can inspect `public/stock-quotes/latest.json` and check:

```json
{
  "symbolsSource": "firestore_stock_trades"
}
```

If it says:

```json
{
  "symbolsSource": "static_symbols_json"
}
```

then the workflow used the fallback list because Firestore discovery was not configured.

## Frontend Behavior

The app fetches:

```text
${import.meta.env.BASE_URL}stock-quotes/latest.json
```

When the user clicks update quotes, matching symbols are copied into:

```text
users/{uid}/stockPrices/{symbol}
```

Manual fallback prices still use the same collection with:

```json
{
  "source": "manual",
  "quoteType": "manual"
}
```

If the cache does not contain a held symbol, the app shows:

```text
報價快取未包含此股票；如剛新增持倉，請先執行 Update Stock Quotes workflow；如仍缺少，請確認 workflow 已設定 Firestore symbol discovery 或手動加入 symbols.json
```

If the cache is stale, the app shows:

```text
報價快取可能已過期
```

## Symbol Rules

- Symbols are uppercased.
- Only `A-Z`, `0-9`, `.`, and `-` are allowed.
- The GitHub Actions updater supports up to 50 symbols.
- The app refresh action applies up to 25 current holding symbols at a time.
- Arbitrary URLs are never accepted.

## Deployment Notes

This quote system does not require:

- Cloudflare Worker
- Vercel serverless functions
- API keys
- Frontend environment variables for quote proxy URLs

`firebase-admin` and `yahoo-finance2` should not be imported from browser code. They are only for the Node.js updater script and GitHub Actions.

## Limitations

- Quotes may be delayed, stale, unavailable, throttled, or changed by Yahoo without notice.
- There is no realtime feed.
- There is no quote history chart.
- This does not change `stockTrades`, `cashMovements`, reconciliation snapshots, CSV import, Treasury calculations, or portfolio cost/cash logic.
