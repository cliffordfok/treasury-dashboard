# 美國國債帳本

以 React、Firebase 與 FRED 收益率曲線資料建立的個人美國國債帳本。應用程式支援 T-Bill、T-Note、T-Bond、持倉估值、全價損益、派息日曆、YTM 試算及 JSON 匯入／匯出。

## 目前限制

- TIPS 需要 CPI 指數比率、通脹調整後本金及通縮下限。現有及由備份還原的 TIPS 記錄會保留及顯示，但不會計入估值、YTM、利息或損益；介面仍會阻擋手動新增 TIPS。
- FRED CMT 曲線只用作獨立的理論淨價估算，並以曲線共同觀察日作估值日。附息債券先由 CMT 平價收益率逐半年推算（bootstrap）零息折現曲線，再逐筆現金流折現，反映低票息或高票息長債的票息效應；T-Bill 按曲線插值的投資收益率定價。理論估值不會自動覆寫使用者輸入的市場淨價；理論估值不應視為個別 CUSIP 的可成交報價。帳本可按「採用為市場價」手動採用，報價日會記為 FRED 觀察日。
- 自訂市場淨價會記錄報價日（`priceUpdatedAt`）。現價 YTM 按該報價日計算，避免舊價格隨到期日接近而令 YTM 虛高；市值及未實現損益仍沿用使用者輸入的價格。報價超過 7 日未更新或沒有報價日期時，介面會顯示提示。
- 組合加權平均 YTM 按全價市值加權，賣空倉位以負收益計入（代表需支付的收益）。
- 附息債券 YTM 採用市場 street convention：首個派息期按實際日數比例（距下次派息日數 ÷ 當期日數）折現，其後以完整半年期複利折現；只剩最後一個派息期時改用單利（money-market）收益率。T-Bill 按財政部投資收益率公式，年基數視乎之後一年是否包含 2 月 29 日（由 2 月 29 日起計的一年為 365 日）。定價模型更新後，已儲存的 FRED 理論估值會在下次載入時自動重算。
- T-Note 及 T-Bond 按美國國債的半年派息慣例處理；新增及匯入資料不接受其他派息頻率。
- 為兼容現有備份及 Firestore Schema，`tradeDate` 與 `closeDate` 保留舊欄位名稱，但其值分別代表買入／開倉及賣出／平倉的**交收日**。應按成交確認書填寫；程式不會自行推算 T+1。
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

### 使用 Firebase Emulator 開發

毋須連接正式 Firebase 專案，亦可在本機完整測試登入及帳本：

```bash
npm run emulators            # 另開終端機執行，啟動 Auth 及 Firestore Emulator
# 在 .env 設定 VITE_USE_FIREBASE_EMULATORS=true
npm run dev
```

Emulator 模式只在 `npm run dev` 生效，Production Build 會忽略此設定；Vite 開發伺服器亦只會在此模式下把 Emulator 位址加入 CSP。

FRED 資料由 `.github/workflows/deploy.yml` 在伺服器端取得，並只寫入當次 GitHub Pages artifact；工作流程不會再由 bot 直接 Push `main`。每次 `main` 部署、手動部署及平日排程部署都會重新擷取資料，只發布 11 個指定年期均有數值的最近共同觀察日。瀏覽器及 Vite 建置程序不會收到 FRED API Key，前端亦會再次驗證點數、年期及觀察日期。

新增交易及 YTM 試算器支援 CUSIP 自動帶入：輸入 9 位 CUSIP 後，會按財政部資料自動填入債券類型、到期日及票息，並以 CUSIP 檢查碼提示輸入錯誤。資料由部署流程從 U.S. Treasury Fiscal Data 的「Treasury Securities Auctions Data」擷取所有未到期的 T-Bill、T-Note 及 T-Bond，發布為 `treasury-securities.json`（同一 CUSIP 的增發會合併為一筆）。擷取失敗不會阻止部署，表單會改為提示手動輸入；CI 亦會對正式 API 做非阻塞的檢查。

帳本會在裝置的 IndexedDB 保留一份副本：離線時仍可開啟及查看，離線期間的新增或修改會先套用在裝置上，重新連線後自動同步（匯入需要連線，以確保整批原子寫入）。更新交易時只寫入該操作改動的欄位，避免覆蓋其他裝置同時作出的修改。登出時會清除這部裝置上的帳本副本。

交易的刪除操作會先要求確認，然後移至帳本內的「回收桶」。回收桶保留完整交易資料並可隨時復原，不會直接永久刪除 Firestore 文件。

JSON 匯入每次上限為 1 MB／500 筆，並使用 Firestore 原子批次寫入；批次失敗時不會留下只匯入一部分的資料。備份會保留回收桶狀態及既有 TIPS，重複判斷以交易 `id` 為準，並允許同一 CUSIP、交收日期及面值的多筆真實成交。

## 驗證

```bash
npm run lint
npm test
npm run test:rules
npm run test:e2e
npm run build
```

或一次執行應用程式檢查（Firestore 規則測試仍需另外執行）：

```bash
npm run check
```

回歸測試涵蓋 ISO 日期解析、夏令時間日數、到期日結算、月末派息時間表、應計利息、全價損益、到期現金流、FRED 曲線完整性、理論估值日期防倒退、按報價日計算 YTM、賣空倉位的組合收益、匯入時拒絕缺少平倉資料或無效文件 ID、Firestore 錯誤訊息、可復原刪除及 TIPS 防護。頁面跨午夜時會自動更新估值日，無需重新載入。

`npm run test:e2e` 會啟動 Firebase Auth／Firestore Emulator 及 Vite 開發伺服器，以 Playwright 在 Chromium 實際操作應用程式：匯入、舊報價提示、採用 FRED 價、手動改價、匯出、編輯已平倉交易、收益率曲線提示、離線開啟、離線修改後同步、只寫入改動欄位及登出清除快取。首次執行前需要 `npx playwright install chromium`；已安裝 Chromium 的環境可設定 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向其執行檔。CI 會在每個 Pull Request 執行同一套測試。

## Firebase 安全規則

`firestore.rules` 只允許已登入使用者存取自己的 `users/{uid}/trades/{tradeId}`，並驗證文件欄位、型別、數值範圍、真實日曆日期、日期關係、平倉資料及 FRED 估值資料。規則拒絕用戶端永久刪除，只容許應用程式以 `deletedAt` 軟刪除及復原。規則容許還原 Schema 有效的 TIPS 備份，但介面不會建立新 TIPS，亦不會將 TIPS 納入未支援的計算。

### 只限個人帳號使用

預設情況下，任何 Google 帳號登入後都可以使用各自獨立的帳本。如只供自己使用，可在 `firestore.rules` 的 `allowedUserIds()` 填入自己的 Firebase Auth UID，例如 `return ['你的UID'];`，然後部署規則；清單以外的帳號會被拒絕讀寫。UID 可在 Firebase Console 的 Authentication → Users 查看，或在應用程式右上角電郵位置以滑鼠停留查看。

`npm run test:rules` 會以 `demo-treasury-dashboard` 本機 Emulator 專案驗證擁有權、Schema、軟刪除、永久刪除防護、帳號白名單及既有 TIPS 相容性，不會連接正式 Firebase 資源。正式環境規則部署是一個獨立批准步驟，不包含在 GitHub Pages 部署內。

## Firebase App Check

Production Build 設定 `VITE_FIREBASE_APPCHECK_SITE_KEY` 後，會在 Auth／Firestore 初始化前啟動 reCAPTCHA Enterprise App Check 及自動更新 Token。啟用前需完成以下步驟：

1. 在 Firebase App Check 為 Web App 登記 reCAPTCHA Enterprise Key。
2. 將公開 Site Key 加入 GitHub Actions Secret `VITE_FIREBASE_APPCHECK_SITE_KEY`。
3. 先部署並監察 App Check 指標，確認合法流量有有效 Token。
4. 經獨立 Production 批准後，才在 Firebase Console 對 Firestore 啟用 Enforcement。

未設定 Site Key 時不會初始化 App Check。本機開發不會自動啟用 Production App Check；正式 Enforcement 後，應使用獨立開發專案或按 Firebase 官方方法設定 Debug Provider。

`index.html` 的 Content Security Policy 已容許 `https://apis.google.com`，這是 Firebase Auth Google 彈出式登入必需載入的腳本；移除後新登入會出現 `auth/internal-error`。

## 部署

合併至 `main`、手動觸發或平日 UTC 22:00 排程時，GitHub Actions 會先取得完整 FRED 曲線，再執行 Lint、測試及建置，最後把同一個 artifact 部署至 GitHub Pages。FRED 擷取、資料完整性檢查、測試或 Build 任一步失敗，都不會執行部署。排程只改變 Pages artifact，不會改動受保護的 `main`。

部署需要以下 Repository Secrets：

- `FRED_API_KEY`（舊名稱 `VITE_FRED_API_KEY` 仍可作過渡後備；建議改用新名稱，避免 `VITE_` 前綴令人誤以為可放入前端）
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- 可選的 `VITE_FIREBASE_APPCHECK_SITE_KEY`

## 授權

本專案以 [MIT License](LICENSE) 授權。
