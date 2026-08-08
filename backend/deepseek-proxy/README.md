# DeepSeek 人工智能代理服務

供美國國債帳本人工智能交易資料擷取功能使用的 Cloudflare Worker 代理服務。

瀏覽器透過 `VITE_AI_PROXY_URL` 呼叫此 Worker，並在 `X-DeepSeek-API-Key`
標頭傳送使用者提供的金鑰。Worker 沒有共用的服務供應商金鑰，因此公開端點
不會消耗專案擁有者的 DeepSeek 餘額。前端只會把使用者金鑰保留在頁面記憶體。

## 部署

```bash
cd backend/deepseek-proxy
npm install
npx wrangler login
npx wrangler deploy
```

部署後，把 Worker 網址複製至 GitHub 儲存庫密鑰 `VITE_AI_PROXY_URL`，
再重新部署 GitHub Pages。

`wrangler.toml` 內的 Worker 變數：

- `DEEPSEEK_MODEL`：預設為 `deepseek-v4-pro`。
- `ALLOWED_ORIGIN`：以逗號分隔、獲准呼叫此 Worker 的瀏覽器來源。

沒有使用者金鑰的請求會收到 `401`；來自 `ALLOWED_ORIGIN` 以外來源的瀏覽器
請求會收到 `403`。

## 支援的任務

Worker 只支援 `extractTradeData`，用於把貼上的債券交易文字轉成應用程式目前
使用的 `users/{uid}/trades` 美國國債交易資料格式。
