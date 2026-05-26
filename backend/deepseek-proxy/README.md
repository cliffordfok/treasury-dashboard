# DeepSeek AI Proxy

Cloudflare Worker proxy for the Treasury Dashboard AI features.

The browser calls this worker through `VITE_AI_PROXY_URL`. The worker reads
`DEEPSEEK_API_KEY` from Cloudflare secrets and calls DeepSeek server-side, so the
API key is never bundled into GitHub Pages.

## Deploy

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
