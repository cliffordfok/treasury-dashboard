# 美國國債帳本

以 React、Firebase 與 FRED 收益率曲線資料建立的個人美國國債帳本。應用程式支援 T-Bill、T-Note、T-Bond、持倉估值、全價損益、派息日曆、YTM 試算、JSON 匯入／匯出及可選的 DeepSeek 自備金鑰交易解析。

## 目前限制

- TIPS 需要 CPI 指數比率、通脹調整後本金及通縮下限。現有 TIPS 記錄會保留及顯示，但不會計入估值、YTM、利息或損益；新增及匯入 TIPS 會被阻擋。
- FRED CMT 曲線只用作獨立的理論淨價估算，不會覆寫使用者輸入的市場淨價；理論估值不應視為個別 CUSIP 的可成交報價。
- T-Note 及 T-Bond 按美國國債的半年派息慣例處理；新增及匯入資料不接受其他派息頻率。
- 定價模型供個人記錄及估算，不應視為券商結單、稅務或投資建議的替代品。
- `firestore.rules` 已納入版本控制，但不會由 GitHub Pages 工作流程自動部署。

## 本機開發

環境需求：Node.js 22.12 或以上。執行 Firestore Emulator 規則測試另需 Java 21。

```bash
npm ci
copy .env.example .env
npm run dev
```

在 `.env` 填寫 Firebase 網頁應用程式設定。Firebase Web API Key 是用戶端設定，不應把管理員憑證或服務供應商密鑰寫入任何 `VITE_` 變數。

FRED 資料由 `.github/workflows/deploy.yml` 在伺服器端取得，並只寫入當次 GitHub Pages artifact；工作流程不會再由 bot 直接 Push `main`。每次 `main` 部署、手動部署及平日排程部署都會重新擷取資料，只發布 11 個指定年期均有數值的最近共同觀察日。瀏覽器及 Vite 建置程序不會收到 FRED API Key，前端亦會再次驗證點數、年期及觀察日期。

交易的刪除操作會先要求確認，然後移至帳本內的「回收桶」。回收桶保留完整交易資料並可隨時復原，不會直接永久刪除 Firestore 文件。

JSON 匯入每次上限為 1 MB／500 筆，並使用 Firestore 原子批次寫入；批次失敗時不會留下只匯入一部分的資料。重複判斷以交易 `id` 為準，允許同一 CUSIP、交易日期及面值的多筆真實成交。

## 驗證

```bash
npm run lint
npm test
npm run test:rules
npm run build
```

或一次執行應用程式檢查（Firestore 規則測試仍需另外執行）：

```bash
npm run check
```

回歸測試涵蓋 ISO 日期解析、夏令時間日數、到期日結算、月末派息時間表、應計利息、全價損益、到期現金流、FRED 曲線完整性、理論估值日期防倒退、可復原刪除、DeepSeek timeout 及 TIPS 防護。頁面跨午夜時會自動更新估值日，無需重新載入。

## Firebase 安全規則

`firestore.rules` 只允許已登入使用者存取自己的 `users/{uid}/trades/{tradeId}`，並驗證文件欄位、型別、數值範圍、日期關係、平倉資料及 FRED 估值資料。規則拒絕用戶端永久刪除，只容許應用程式以 `deletedAt` 軟刪除及復原。新增 TIPS 會被拒絕，既有有效 TIPS 文件仍可保留及更新。

`npm run test:rules` 會以 `demo-treasury-dashboard` 本機 Emulator 專案驗證擁有權、Schema、軟刪除、永久刪除防護及既有 TIPS 相容性，不會連接正式 Firebase 資源。正式環境規則部署是一個獨立批准步驟，不包含在 GitHub Pages 部署內。

## Firebase App Check

Production Build 設定 `VITE_FIREBASE_APPCHECK_SITE_KEY` 後，會在 Auth／Firestore 初始化前啟動 reCAPTCHA Enterprise App Check 及自動更新 Token。啟用前需完成以下步驟：

1. 在 Firebase App Check 為 Web App 登記 reCAPTCHA Enterprise Key。
2. 將公開 Site Key 加入 GitHub Actions Secret `VITE_FIREBASE_APPCHECK_SITE_KEY`。
3. 先部署並監察 App Check 指標，確認合法流量有有效 Token。
4. 經獨立 Production 批准後，才在 Firebase Console 對 Firestore 啟用 Enforcement。

未設定 Site Key 時不會初始化 App Check。本機開發不會自動啟用 Production App Check；正式 Enforcement 後，應使用獨立開發專案或按 Firebase 官方方法設定 Debug Provider。

## DeepSeek 自備金鑰代理服務

`backend/deepseek-proxy` 是可選的 Cloudflare Worker。它只轉送使用者在當前頁面輸入的 DeepSeek 金鑰：

- 金鑰只保留在頁面記憶體，重新載入後清除；
- 解析時，使用者金鑰及貼上的交易文字會經已設定的代理服務傳送至 DeepSeek；
- Worker 沒有共用 `DEEPSEEK_API_KEY`，避免公開端點消耗專案擁有者餘額；
- 瀏覽器來源必須符合 `ALLOWED_ORIGIN`；
- 沒有金鑰的請求會收到 `401`。

部署 Worker 後，把網址設為儲存庫密鑰 `VITE_AI_PROXY_URL`。未設定代理服務時，瀏覽器會以使用者提供的金鑰直接呼叫 DeepSeek API。

## 部署

合併至 `main`、手動觸發或平日 UTC 22:00 排程時，GitHub Actions 會先取得完整 FRED 曲線，再執行 Lint、測試及建置，最後把同一個 artifact 部署至 GitHub Pages。FRED 擷取、資料完整性檢查、測試或 Build 任一步失敗，都不會執行部署。排程只改變 Pages artifact，不會改動受保護的 `main`。

部署需要以下 Repository Secrets：

- `VITE_FRED_API_KEY`
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- 可選的 `VITE_FIREBASE_APPCHECK_SITE_KEY`、`VITE_AI_PROXY_URL`、`VITE_STOCK_QUOTE_PROXY_URL`

## 授權

本專案以 [MIT License](LICENSE) 授權。
