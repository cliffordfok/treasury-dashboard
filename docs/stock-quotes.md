# Stock Quote Proxy

Phase Q2 adds optional stock quote support for the Portfolio Dashboard.

## Source

- Provider: `yahoo_finance_unofficial`
- Quote type: `delayed_or_regular_market`
- This is an unofficial Yahoo Finance quote source.
- No API key is used or stored by the app.
- Quotes may be delayed, unavailable, throttled, or changed by Yahoo Finance without notice.

The browser must not call Yahoo Finance directly. It calls a server-side proxy configured with:

```text
VITE_STOCK_QUOTE_PROXY_URL
```

If the proxy URL is not configured, users can still enter manual stock prices.

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

## Limitations

- This does not add realtime market data guarantees.
- This does not add stock quote history charts.
- This does not change `stockTrades`, `cashMovements`, or reconciliation snapshots.
- This does not change CSV import or duplicate fingerprint logic.
- This does not change Treasury calculations.

