# Stock Quote Proxy

Phase Q2 adds optional stock quote support for the Portfolio Dashboard.

## Source

- Provider: `yahoo_finance_unofficial`
- Quote type: `delayed_or_regular_market`
- This is an unofficial Yahoo Finance quote source.
- No API key is used or stored by the app.
- Quotes may be delayed, unavailable, throttled, or changed by Yahoo Finance without notice.

The browser must not call Yahoo Finance directly. It calls a server-side proxy.

On Vercel, the included Vercel-style endpoint can be used directly:

```text
/api/stock-quotes
```

If `VITE_STOCK_QUOTE_PROXY_URL` is not configured, the app defaults to that same-origin endpoint.

For Firebase Functions, Netlify Functions, GitHub Pages, or any other static hosting setup, deploy your own server-side function with the same contract and configure:

```text
VITE_STOCK_QUOTE_PROXY_URL
```

If you already use the included Cloudflare Worker for AI analysis, the same worker also accepts the stock quote contract after deploying the latest worker code. In that setup, the frontend can reuse:

```text
VITE_AI_PROXY_URL
```

Resolution order:

1. `VITE_STOCK_QUOTE_PROXY_URL`
2. `VITE_AI_PROXY_URL`
3. `VITE_GEMINI_PROXY_URL`
4. `/api/stock-quotes`

GitHub Pages does not run `/api/stock-quotes`; it needs one of the proxy environment variables above.

After changing any Vite environment variable, rebuild and redeploy the app. If the proxy is unavailable, users can still enter manual stock prices.

## Proxy Contract

Request:

```http
POST /api/stock-quotes
Content-Type: application/json
```

```json
{
  "symbols": ["VOO", "NVDA", "GOOGL"]
}
```

Response:

```json
{
  "provider": "yahoo_finance_unofficial",
  "quoteType": "delayed_or_regular_market",
  "quotes": [
    {
      "symbol": "VOO",
      "price": 693.12,
      "currency": "USD",
      "asOf": "2026-06-04T20:00:00.000Z",
      "previousClose": 690.25,
      "change": 2.87,
      "changePercent": 0.42,
      "source": "yahoo_finance_unofficial"
    }
  ],
  "errors": []
}
```

Per-symbol errors should be returned without failing the full request:

```json
{
  "symbol": "XYZ",
  "error": "No quote returned"
}
```

## Proxy Safety Rules

- Uppercase symbols before calling Yahoo Finance.
- Allow only `A-Z`, `0-9`, `.`, and `-` in symbols.
- Limit each request to 25 symbols.
- Do not accept arbitrary Yahoo URLs from the browser.
- Do not expose any API key.
- Use a timeout.
- Return per-symbol errors when Yahoo has no quote.
- Do not crash the whole request for one bad symbol.
- Do not write to Firestore from the proxy.

## Firestore Schema

Stock prices are stored separately from stock trades:

```text
users/{uid}/stockPrices/{symbol}
```

Document shape:

```json
{
  "symbol": "VOO",
  "price": 693.12,
  "currency": "USD",
  "asOf": "2026-06-04T20:00:00.000Z",
  "source": "yahoo_finance_unofficial",
  "quoteType": "delayed_or_regular_market",
  "previousClose": 690.25,
  "change": 2.87,
  "changePercent": 0.42,
  "updatedAt": "serverTimestamp"
}
```

Manual fallback prices use the same collection with:

```json
{
  "source": "manual",
  "quoteType": "manual"
}
```

## Auto Refresh

The app can attempt an automatic quote refresh when a user opens the app or visits the Stocks page.

- Only current holdings with `shares > 0` are considered.
- Symbols without a saved price are refreshed.
- Symbols with a saved price older than 12 hours are refreshed.
- Automatic attempts have a 15 minute local cooldown per user.
- The user can disable automatic quote refresh with the `portfolio:autoQuote:enabled` localStorage setting.
- Manual quote refresh ignores the cooldown.
- Automatic refresh does not overwrite a newer manual price. Manual refresh can overwrite it.
- There is no server-side cron, scheduled function, realtime feed, or quote history chart.

## Limitations

- This does not add realtime market data guarantees.
- This does not add stock quote history charts.
- This does not change `stockTrades`, `cashMovements`, or reconciliation snapshots.
- This does not change CSV import or duplicate fingerprint logic.
- This does not change Treasury calculations.
