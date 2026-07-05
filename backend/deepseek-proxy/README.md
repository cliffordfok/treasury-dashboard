# DeepSeek AI Proxy

Cloudflare Worker proxy for the Bond Ledger AI trade extraction feature.

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

## Supported task

The worker only supports `extractTradeData`, which converts pasted bond trade
text into the current `users/{uid}/trades` Treasury trade shape used by the app.
