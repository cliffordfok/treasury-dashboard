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
報價快取未包含此股票；請先加入 public/stock-quotes/symbols.json，然後執行 Update Stock Quotes workflow
```

New holdings are not discovered automatically by GitHub Actions because the static
cache updater does not read user Firestore data. When a new stock or ETF is added
to the ledger, add its symbol to `public/stock-quotes/symbols.json`, merge the
change, then run the `Update Stock Quotes` workflow.

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
