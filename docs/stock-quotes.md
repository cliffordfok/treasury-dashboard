# Stock Quotes

Stock quotes are enabled for the Stock Ledger through Twelve Data.

## Current Design

- The user enters a Twelve Data API key in the Stock Ledger page.
- The key is stored only in the current browser `localStorage`.
- The key is not written to Firestore and is not included in JSON backups.
- The app sends active holding symbols to Twelve Data from the browser.
- Successful quotes are saved to:

```text
users/{uid}/stockPrices/{symbol}
```

The quote data is used only for:

- Current Price
- Market Value
- Unrealized P&L
- Priced Symbols / Quote Status

Ledger calculations remain based on recorded trades:

- Average cost
- Remaining cost
- Realized P&L
- Stock trade cash impact
- Cash balance
- Treasury calculations
- CSV import

## API Key

In the Stock Ledger page:

1. Open `API Key`.
2. Paste the Twelve Data API key.
3. Save.
4. Click `更新持倉報價`.

The key can be cleared from the same panel.

## Manual Price Fallback

The manual price form is still available. Manual prices write to the same `stockPrices` path with:

```text
source: manual
quoteType: manual
```

## Portfolio Overview and AI

Portfolio Overview asset allocation remains book-value / cost-basis based. It does not use stock quotes.

AI analysis also does not use stock quotes. AI reports remain based on cost, holdings, cash flow, realized P&L, and Treasury data.
