# DeepSeek AI Proxy

Cloudflare Worker proxy for the Treasury Dashboard AI features and stock quote
requests.

The browser calls this worker through `VITE_AI_PROXY_URL`. The worker reads
`DEEPSEEK_API_KEY` from Cloudflare secrets and calls DeepSeek server-side, so the
API key is never bundled into GitHub Pages.

The frontend can also send a user-provided key in the `X-DeepSeek-API-Key`
header. This is for users who want to use their own DeepSeek key from their own
browser. If the header is empty, the Worker falls back to its server-side
`DEEPSEEK_API_KEY` secret.

## Deploy

### Windows helper

In PowerShell:

```powershell
cd backend/deepseek-proxy
powershell -ExecutionPolicy Bypass -File .\setup-secret.ps1
```

When Wrangler asks for `DEEPSEEK_API_KEY`, paste your new DeepSeek API key. The
key is sent to Cloudflare as a Worker secret and is not saved into this repo.

### Manual commands

```bash
cd backend/deepseek-proxy
npm install
npx wrangler login
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler deploy
```

After deployment, copy the worker URL into the GitHub repository secret
`VITE_AI_PROXY_URL`, then redeploy GitHub Pages.

Optional worker variables in `wrangler.toml`:

- `DEEPSEEK_MODEL`: defaults to `deepseek-v4-pro`.
- `ALLOWED_ORIGIN`: comma-separated browser origins allowed to call this worker.

## Stock Quotes

The same worker can also serve the stock quote proxy contract used by the
Portfolio Dashboard:

```json
{
  "symbols": ["VOO", "NVDA"]
}
```

The frontend will use `VITE_STOCK_QUOTE_PROXY_URL` when it is set. If it is not
set, it can reuse `VITE_AI_PROXY_URL`, so GitHub Pages can call this worker for
quotes without a separate proxy deployment.

Stock quote requests do not use a DeepSeek API key. The worker calls Yahoo
Finance unofficial quote data server-side and returns normalized quotes plus
per-symbol errors.
