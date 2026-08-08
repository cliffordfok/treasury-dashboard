# DeepSeek AI Proxy

Cloudflare Worker proxy for the Bond Ledger AI trade extraction feature.

The browser calls this worker through `VITE_AI_PROXY_URL` and sends a
user-provided key in the `X-DeepSeek-API-Key` header. The Worker has no shared
provider key, so a public endpoint cannot spend the project owner's DeepSeek
balance. The frontend keeps the user key in page memory only.

## Deploy

```bash
cd backend/deepseek-proxy
npm install
npx wrangler login
npx wrangler deploy
```

After deployment, copy the worker URL into the GitHub repository secret
`VITE_AI_PROXY_URL`, then redeploy GitHub Pages.

Worker variables in `wrangler.toml`:

- `DEEPSEEK_MODEL`: defaults to `deepseek-v4-pro`.
- `ALLOWED_ORIGIN`: comma-separated browser origins allowed to call this worker.

Requests without a user key receive `401`; browser requests from origins outside
`ALLOWED_ORIGIN` receive `403`.

## Supported task

The worker only supports `extractTradeData`, which converts pasted bond trade
text into the current `users/{uid}/trades` Treasury trade shape used by the app.
