# Stock Quote Cache

The Portfolio Dashboard uses a static quote cache for stock market value and unrealized P&L estimates.

## Source

- Provider: `yahoo_finance2`
- Saved quote source: `yahoo_finance2_quote_cache`
- Quote type: `delayed_or_regular_market`
- Yahoo does not provide an official public quote API for this use case.
- `yahoo-finance2` is an unofficial wrapper and may break if Yahoo changes its responses.
- No API key is required.
- Quotes are for portfolio value estimates only and are not trading advice.

The browser must not call Yahoo Finance directly. The project only uses `yahoo-finance2` in Node.js through GitHub Actions.

## Cache Files

Symbols are maintained in:

```text
public/stock-quotes/symbols.json
```

Example:

```json
{
  "symbols": ["VOO", "GOOGL", "MU", "NVDA"],
  "provider": "yahoo_finance2",
  "note": "Used by GitHub Actions quote cache updater"
}
```

The updater can also discover symbols from Firestore. If the GitHub secret
`FIREBASE_SERVICE_ACCOUNT_JSON` is configured, the workflow reads:

```text
users/{uid}/stockTrades/{tradeId}
```

It calculates current stock positions per user and adds symbols with remaining
shares greater than zero to the quote cache update. This means newly added
holdings can be quoted after the next `Update Stock Quotes` workflow run without
editing `symbols.json`.

`symbols.json` remains useful as a fallback/static watch list when Firestore
discovery is not configured.

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
  "errors": []
}
```

## GitHub Actions

The workflow is:

```text
.github/workflows/update-stock-quotes.yml
```

It supports:

- `workflow_dispatch` manual runs.
- A scheduled run at 06:30 Hong Kong time.
- `contents: write` so it can commit an updated `latest.json` back to `main`.
- Optional Firestore symbol discovery via `FIREBASE_SERVICE_ACCOUNT_JSON`.

The script is:

```text
scripts/update-stock-quotes.mjs
```

It validates symbols, fetches quotes with `yahoo-finance2`, writes per-symbol errors, and updates `public/stock-quotes/latest.json`.

## Manual Update

To update quotes manually:

1. Open the repository on GitHub.
2. Go to Actions.
3. Select `Update Stock Quotes`.
4. Click `Run workflow`.
5. Wait for the workflow to commit `Update stock quote cache`.
6. Let GitHub Pages redeploy from `main`.

## Firestore Symbol Discovery

To make future newly added stocks appear automatically:

1. Create a Firebase service account JSON for the same Firebase project.
2. Add it as a GitHub repository secret named:

```text
FIREBASE_SERVICE_ACCOUNT_JSON
```

The secret can be raw JSON or base64-encoded JSON.

3. Run `Update Stock Quotes`.

The updater only reads stock trade symbols and writes `public/stock-quotes/latest.json`.
It does not write to Firestore and does not change any ledger data.

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
If Firestore symbol discovery is configured, running the workflow is enough for
new positive holdings to be included. If it is not configured, add the symbol to
`public/stock-quotes/symbols.json`.

If the cache is stale, the app shows:

```text
報價快取可能已過期
```

## Symbol Rules

- Symbols are uppercased.
- Only `A-Z`, `0-9`, `.`, and `-` are allowed.
- The GitHub Actions updater supports up to 50 configured symbols.
- The app refresh action applies up to 25 current holding symbols at a time.
- Arbitrary URLs are never accepted.

## Deployment Notes

This quote system does not require:

- Cloudflare Worker
- Vercel serverless functions
- API keys
- Frontend environment variables for quote proxy URLs

`yahoo-finance2` should not be imported from browser code. It is only for the Node.js updater script and GitHub Actions.

## Limitations

- Quotes may be delayed, stale, unavailable, throttled, or changed by Yahoo without notice.
- There is no realtime feed.
- There is no quote history chart.
- This does not change `stockTrades`, `cashMovements`, reconciliation snapshots, CSV import, Treasury calculations, or portfolio cost/cash logic.
