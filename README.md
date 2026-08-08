# Treasury Dashboard

以 React、Firebase 與 FRED yield curve 資料建立的個人美國國債帳本。應用程式支援 T-Bill、T-Note、T-Bond、持倉估值、dirty-price P&L、coupon calendar、YTM 試算、JSON 匯入／匯出及可選的 DeepSeek BYOK 交易解析。

## 目前限制

- TIPS 需要 CPI index ratio、inflation-adjusted principal 及 deflation floor。現有 TIPS 記錄會保留及顯示，但不會計入估值、YTM、利息或 P&L；新增及匯入 TIPS 會被阻擋。
- 定價模型供個人記錄及估算，不應視為券商結單、稅務或投資建議的替代品。
- `firestore.rules` 已納入版本控制，但不會由 GitHub Pages workflow 自動部署。

## 本機開發

需求：Node.js 20。

```bash
npm ci
copy .env.example .env
npm run dev
```

在 `.env` 填寫 Firebase Web App 設定。Firebase Web API key 是 client configuration，不應把管理員憑證或 provider secret 寫入任何 `VITE_` 變數。

FRED 資料由 `.github/workflows/fetch-yield-curve.yml` 在 server-side 取得並寫入 `public/yield-curve.json`；瀏覽器及 Vite build 不會收到 FRED API key。

## 驗證

```bash
npm run lint
npm test
npm run build
```

或一次執行：

```bash
npm run check
```

回歸測試涵蓋 ISO date parsing、DST 日數、月末 coupon schedule、accrued interest、dirty-price P&L 及 TIPS 防護。

## Firebase 安全規則

`firestore.rules` 只允許已登入使用者存取自己的 `users/{uid}/trades/{tradeId}`。部署前必須先在目標 Firebase project review 規則；Production 規則部署是一個獨立批准步驟，不包含在 GitHub Pages deployment。

## DeepSeek BYOK proxy

`backend/deepseek-proxy` 是可選的 Cloudflare Worker。它只轉送使用者在當前頁面輸入的 DeepSeek key：

- key 只保留在頁面記憶體，重新載入後清除；
- Worker 沒有共用 `DEEPSEEK_API_KEY`，避免公開 endpoint 消耗專案擁有者餘額；
- browser origin 必須符合 `ALLOWED_ORIGIN`；
- 沒有 key 的請求會收到 `401`。

部署 Worker 後，把 URL 設為 repository secret `VITE_AI_PROXY_URL`。未設定 proxy 時，瀏覽器會以使用者提供的 key 直接呼叫 DeepSeek API。

## Deployment

合併至 `main` 後，GitHub Actions 會依序執行 lint、tests、build，再部署至 GitHub Pages。FRED workflow 更新 `yield-curve.json` 並 push 至 `main` 時，會觸發同一條 deployment workflow，不會再產生重複 deploy run。
