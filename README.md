# 美國國債帳本

以 React、Firebase 與 FRED 收益率曲線資料建立的個人美國國債帳本。應用程式支援 T-Bill、T-Note、T-Bond、持倉估值、全價損益、派息日曆、YTM 試算、JSON 匯入／匯出及可選的 DeepSeek 自備金鑰交易解析。

## 目前限制

- TIPS 需要 CPI 指數比率、通脹調整後本金及通縮下限。現有 TIPS 記錄會保留及顯示，但不會計入估值、YTM、利息或損益；新增及匯入 TIPS 會被阻擋。
- 定價模型供個人記錄及估算，不應視為券商結單、稅務或投資建議的替代品。
- `firestore.rules` 已納入版本控制，但不會由 GitHub Pages 工作流程自動部署。

## 本機開發

環境需求：Node.js 20。

```bash
npm ci
copy .env.example .env
npm run dev
```

在 `.env` 填寫 Firebase 網頁應用程式設定。Firebase Web API Key 是用戶端設定，不應把管理員憑證或服務供應商密鑰寫入任何 `VITE_` 變數。

FRED 資料由 `.github/workflows/fetch-yield-curve.yml` 在伺服器端取得並寫入 `public/yield-curve.json`；瀏覽器及 Vite 建置程序不會收到 FRED API Key。

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

回歸測試涵蓋 ISO 日期解析、夏令時間日數、月末派息時間表、應計利息、全價損益及 TIPS 防護。

## Firebase 安全規則

`firestore.rules` 只允許已登入使用者存取自己的 `users/{uid}/trades/{tradeId}`。部署前必須先在目標 Firebase 專案審閱規則；正式環境規則部署是一個獨立批准步驟，不包含在 GitHub Pages 部署內。

## DeepSeek 自備金鑰代理服務

`backend/deepseek-proxy` 是可選的 Cloudflare Worker。它只轉送使用者在當前頁面輸入的 DeepSeek 金鑰：

- 金鑰只保留在頁面記憶體，重新載入後清除；
- Worker 沒有共用 `DEEPSEEK_API_KEY`，避免公開端點消耗專案擁有者餘額；
- 瀏覽器來源必須符合 `ALLOWED_ORIGIN`；
- 沒有金鑰的請求會收到 `401`。

部署 Worker 後，把網址設為儲存庫密鑰 `VITE_AI_PROXY_URL`。未設定代理服務時，瀏覽器會以使用者提供的金鑰直接呼叫 DeepSeek API。

## 部署

合併至 `main` 後，GitHub Actions 會依序執行程式碼檢查、測試及建置，再部署至 GitHub Pages。FRED 工作流程更新 `yield-curve.json` 並推送至 `main` 時，會觸發同一條部署工作流程，不會再產生重複部署作業。
