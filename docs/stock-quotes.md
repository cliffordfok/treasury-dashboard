# Stock Quotes

Stock quotes are used only for estimated current price, market value, and unrealized P&L. They are not trading advice.

## Primary Design

The app derives quote symbols from the current user's Stock Ledger positions in the browser:

1. Read `stockTrades` already loaded for the signed-in user.
2. Calculate current positions.
3. Keep only positions with `shares > 0`.
4. Send those symbols to a server-side quote proxy:

```http
POST /api/stock-quotes
Content-Type: application/json

{ "symbols": ["VOO", "GOOGL", "MU", "NVDA"] }
```

The browser must not call Yahoo Finance directly. The proxy fetches the Yahoo Finance unofficial quote endpoint server-side and returns:

```json
{
  "provider": "yahoo_finance_unofficial",
  "quoteType": "delayed_or_regular_market",
  "quotes": [],
  "errors": []
}
```

New stocks do not require editing `symbols.json`. Once a stock has a current holding, the next automatic refresh or manual "更新持倉報價" action includes it in the proxy request.

## Proxy URL

Frontend resolution order:

1. `VITE_STOCK_QUOTE_PROXY_URL`
2. Same-origin `/api/stock-quotes`

If the proxy is unavailable, the app keeps existing saved prices and manual price fallback available.

## Vercel Deployment

Vercel can run `api/stock-quotes.js` as a serverless function.

1. Import the GitHub repo into Vercel.
2. Build command: `npm run build`
3. Output directory: `dist`
4. Environment variable:

```text
VITE_STOCK_QUOTE_PROXY_URL=/api/stock-quotes
```

5. Deploy.
6. Open the app and click `更新持倉報價`.

You can also leave `VITE_STOCK_QUOTE_PROXY_URL` unset on Vercel because the app falls back to `/api/stock-quotes`.

## Netlify Or Other Serverless Hosting

Use an equivalent server-side function that accepts the same POST body and returns the same response schema. Then set:

```text
VITE_STOCK_QUOTE_PROXY_URL=https://your-server-side-proxy-url
```

After changing any `VITE_` environment variable, rebuild and redeploy the frontend.

## GitHub Pages Limitation

GitHub Pages is static hosting only. It cannot run `/api/stock-quotes.js`, so the same-origin proxy will not work there.

If continuing to use GitHub Pages, use one of these fallbacks:

- Manual stock prices in the Stock Dashboard.
- Optional static quote cache files under `public/stock-quotes`.

## Optional Static Quote Cache Fallback

The repository still includes an optional static cache updater:

- `public/stock-quotes/symbols.json`
- `public/stock-quotes/latest.json`
- `scripts/update-stock-quotes.mjs`
- `.github/workflows/update-stock-quotes.yml`

This fallback uses `yahoo-finance2` in Node.js through GitHub Actions and does not require Firebase Admin, a service account key, or Firestore access. It is not the primary quote path because the symbol list is static.

To use it, manually maintain:

```json
{
  "symbols": ["VOO", "GOOGL", "MU", "NVDA"],
  "provider": "yahoo_finance2",
  "note": "Used by GitHub Actions quote cache updater"
}
```

Then run the `Update Stock Quotes` workflow or wait for its schedule. The app's primary refresh button still uses the quote proxy; the static cache is only a fallback artifact.

## Health Check

`GET /api/stock-quotes` should return a health check JSON response. Quote requests must use POST:

```bash
curl -X POST "https://your-proxy-url/api/stock-quotes" \
  -H "Content-Type: application/json" \
  -d '{"symbols":["VOO","GOOGL","MU","NVDA"]}'
```

## Notes

- Yahoo Finance does not provide an official free public API for this use case.
- The quote proxy uses an unofficial Yahoo Finance source and may break if Yahoo changes its endpoint.
- Quotes may be delayed or regular market values depending on Yahoo's response.
- `yahoo-finance2` is only used by the optional Node.js cache updater, never in the browser bundle.
- No Firebase Admin SDK or service account key is required for the primary quote proxy flow.
