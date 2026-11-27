# Cloudflare Worker KV 唯讀分享與 API v2.1 同步功能 — 部署與驗證手冊

> 📖 若您已完成部署，欲查詢 `/api/v1/ingest` 批次寫入、局部修改 (`PATCH`)、精準刪除 (`DELETE`)、多頻道查詢、匯出 (`CSV/ICS/GPX`) 與子金鑰管理之完整規格，請參閱 **[外部寫入與雲端自動同步 API 使用指南 (API_GUIDE.md)](./API_GUIDE.md)**。

本手冊提供兩條部署路徑：
- **路徑 A：GitHub Actions 自動化部署 (推薦)** — 透過 `.github/workflows/deploy.yml` 通過 CI 門禁後自動注入 KV ID、執行 `--dry-run` 驗證並發布。
- **路徑 B：Cloudflare Dashboard / Wrangler CLI 手動部署** — 直接在網頁或本機終端機操作，適合快速測試或排錯。

---

## 共通步驟 1：建立 KV Namespace (不論哪種路徑皆必備)

1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com)。
2. 於左側選單選擇 **Workers & Pages** → **KV**。
3. 點擊 **Create a namespace**。
4. **Name**：輸入 `SHARED_TRIPS`（或自訂易辨識名稱）。
5. **複製 Namespace ID**（32 位十六進位字串，例如 `a1b2c3d4e5f67890123456789abcdef0`）。

---

## 共通步驟 2：設定 Worker 機密與環境變數 (Cloudflare 端)

> ⚠️ **重要提醒**：`.github/workflows/deploy.yml` 僅負責將程式碼與 `SHARED_TRIPS` KV 綁定部署至 Cloudflare，**不會**自動把 GitHub Secrets 同步為 Worker Secrets。請務必在 **Cloudflare Dashboard → 您的 Worker (`flight-api-proxy`) → Settings → Variables and Secrets**（或本機執行 `wrangler secret put`）設定以下變數：

| 變數名稱 | 類型 | 必填 | 說明 |
| :--- | :--- | :---: | :--- |
| `API_SECRET_TOKEN` | **Secret** | 🟢 啟用 `/api/v1/*` 必備 | Master API Key，供外部 cURL / AI Agent / 自動化腳本存取 `/api/v1/*`。支援**逗號分隔多把金鑰**（如 `key_new,key_old`）以實現零停機輪替。 |
| `ALLOWED_ORIGINS` | Variable | ⚪ 選填 (強烈建議自訂網域時設定) | CORS 允許來源白名單（逗號分隔）。未設定時預設為 `https://imhahac.github.io,http://localhost:5173,http://127.0.0.1:5173`。若您 Fork 本專案至個人 GitHub Pages，請填入 `https://<你的帳號>.github.io`。 |
| `SHARE_SECRET_TOKEN` | **Secret** | ⚪ 選填 | 若設定，則 `POST /share` 必須攜帶 `Authorization: Bearer` 或 `X-API-Key` 才允許建立公開快照；若 `API_SECRET_TOKEN` 未設定，亦會回退使用此值。 |
| `REQUIRE_PROXY_AUTH` | Variable | ⚪ 選填 | 設為 `"true"` 時，付費航班查詢代理（`/?api=aviationstack\|airlabs`）強制要求驗證 API 金鑰以防額度遭盜用；`?api=unshorten` 仍維持公開並受 SSRF 保護。預設不要求。 |
| `AVIATIONSTACK_API_KEY` | **Secret** | ⚪ 選填 | AviationStack 航班查詢 API 金鑰（用於 `/?api=aviationstack`）。 |
| `AIRLABS_API_KEY` | **Secret** | ⚪ 選填 | AirLabs 航班查詢 API 金鑰（用於 `/?api=airlabs`）。 |

若使用 Wrangler CLI 設定機密：
```bash
cd cloudflare-worker
npx wrangler secret put API_SECRET_TOKEN
# 選填：
npx wrangler secret put AVIATIONSTACK_API_KEY
npx wrangler secret put AIRLABS_API_KEY
```

---

## 🚀 路徑 A：GitHub Actions 自動化部署 (推薦)

### 1. 設定 GitHub Repository Secrets 與 Variables
請至 GitHub 儲存庫的 **Settings** → **Secrets and variables** → **Actions**：

- **Variables (公開變數)**：
  - `SHARED_TRIPS_KV_ID`：填入共通步驟 1 取得的 **KV Namespace ID**。
  - `VITE_FLIGHT_PROXY_URL`：填入您的 Worker 網址（例如 `https://flight-api-proxy.<your-subdomain>.workers.dev`，供前端 Vite 建置時注入）。

- **Secrets (機密)**：
  - `CLOUDFLARE_API_TOKEN`：具備 Workers 編輯權限的 Cloudflare API Token。

#### 🔑 如何取得 `CLOUDFLARE_API_TOKEN`？
1. 登入 [Cloudflare Dashboard](https://dash.cloudflare.com)。
2. 點擊右上角人像圖示 → **My Profile** → 左側 **API Tokens**。
3. 點擊 **Create Token** → 找到 **Edit Cloudflare Workers** 模板並點擊 **Use template**。
4. 確認 Permissions 具備 `Workers Scripts: Edit`（預設已帶入）。
5. **Account Resources** 選擇您的帳號；**Zone Resources** 選擇 **All zones**（或指定網域）。
6. 點擊 **Continue to summary** → **Create Token**，複製 Token 並填入 GitHub Secret `CLOUDFLARE_API_TOKEN`。

### 2. CI/CD 部署流程與門禁原理
- 本機端 `cloudflare-worker/wrangler.toml` 使用 `id = "__KV_ID__"` 作為安全佔位符，不會將真實 ID 暴露在 Git 紀錄中。
- 當程式碼推送至 `main` 分支時，`.github/workflows/deploy.yml` 會依序執行：
  1. **`build` 門禁**：`npm ci` → `npm audit --omit=dev --audit-level=high` → `npm run lint` → `npm test` → `npm run build`。
  2. **`deploy-worker`（`needs: build`）**：
     - 檢查 `CLOUDFLARE_API_TOKEN` 與 `SHARED_TRIPS_KV_ID` 是否已設定（未設定則優雅跳過，不影響 Pages 部署）。
     - 透過 `sed` 將 `cloudflare-worker/wrangler.toml` 中的 `__KV_ID__` 替換為 `vars.SHARED_TRIPS_KV_ID`。
     - 執行 `wrangler deploy --dry-run` 驗證語法與設定檔。
     - 執行正式 `wrangler deploy` 上線至 Cloudflare 邊緣節點。

---

## 🛠️ 路徑 B：Cloudflare Dashboard / Wrangler CLI 手動部署

### 方式 B1：透過 Wrangler CLI 本機發布
```bash
cd cloudflare-worker
npx wrangler login
# 將 wrangler.toml 中的 __KV_ID__ 暫時改為真實 KV Namespace ID（注意勿將真實 ID commit 回 Git）
npx wrangler deploy --dry-run
npx wrangler deploy
```

### 方式 B2：透過 Cloudflare Dashboard 網頁手動貼上
1. 在 Cloudflare Dashboard 進入 Worker (`flight-api-proxy`)。
2. 點擊 **Settings** → **Bindings** → **Add binding** → 選擇 **KV namespace**：
   - **Variable name**：必須輸入 `SHARED_TRIPS`（大小寫完全一致）。
   - **KV namespace**：選擇共通步驟 1 建立的空間。
3. 進入 **Edit code**，複製專案中 `cloudflare-worker/worker.js` 的全部內容並貼上，點擊 **Deploy**。
4. 至 **Settings** → **Variables and Secrets** 補齊共通步驟 2 所需的機密（至少 `API_SECRET_TOKEN`）。

---

## 🔍 部署後驗證 SOP (API v2.1)

部署完成後，請先在終端機設定變數（不寫入檔案）：
```bash
export WORKER_URL="https://flight-api-proxy.<your-subdomain>.workers.dev"
export API_TOKEN="<YOUR_API_SECRET_TOKEN>"
```

### 1. 健康檢查與 KV 綁定確認（免認證）
```bash
curl -sS "$WORKER_URL/api/v1/health"
```
預期回傳包含 `"ok": true`、`"version": "2.1.0"` 與 `"kvBound": true`。若 `"kvBound": false`，代表 `SHARED_TRIPS` 尚未綁定。

### 2. OpenAPI 3.1 規格書確認（免認證）
```bash
curl -sS "$WORKER_URL/api/v1/openapi.json" | head -c 300
```
預期回傳 `{"openapi":"3.1.0",...}`。

### 3. 驗證認證與金鑰角色（`/api/v1/whoami`）
```bash
curl -sS "$WORKER_URL/api/v1/whoami" \
  -H "Authorization: Bearer $API_TOKEN"
```
預期回傳 `{"success": true, "role": "admin", "keyId": "master", "permissions": ["read", "write", "delete", "admin"], "allowedChannels": ["*"], ...}`。

### 4. 預演驗證（Dry-Run，不寫入 KV）
```bash
curl -sS -X POST "$WORKER_URL/api/v1/ingest?channel=verify-smoke&mode=merge&dryRun=true" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"activity": {"id": "smoke-1", "title": "部署驗證測試", "startDate": "2026-12-24", "time": "20:00"}}'
```
預期回傳 `"success": true, "dryRun": true` 與 `projectedSummary`。

### 5. 完整寫入 → 讀取 → 局部修改 (`PATCH`) → 匯出 → 清理驗證
```bash
# 5a. 寫入測試資料
curl -sS -X POST "$WORKER_URL/api/v1/ingest?channel=verify-smoke&mode=merge" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"activity": {"id": "smoke-1", "title": "部署驗證測試", "startDate": "2026-12-24", "time": "20:00"}}'

# 5b. 局部修改 (PATCH — 僅傳 id 與欲更新欄位，其餘欄位保留)
curl -sS -X PATCH "$WORKER_URL/api/v1/ingest?channel=verify-smoke" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"activity": {"id": "smoke-1", "time": "21:30"}}'

# 5c. 讀取頻道並驗證版本與資料
curl -sS "$WORKER_URL/api/v1/ingest?channel=verify-smoke" \
  -H "X-API-Key: $API_TOKEN"

# 5d. 測試行事曆匯出 (.ics)
curl -sS "$WORKER_URL/api/v1/export?channel=verify-smoke&format=ics" \
  -H "Authorization: Bearer $API_TOKEN"

# 5e. 清理測試頻道
curl -sS -X DELETE "$WORKER_URL/api/v1/ingest?channel=verify-smoke" \
  -H "Authorization: Bearer $API_TOKEN"
```

### 6. 唯讀快照分享測試 (`/share`)
```bash
# 建立快照（若已設定 SHARE_SECRET_TOKEN，請加上 -H "Authorization: Bearer <SHARE_SECRET_TOKEN>"）
SHARE_ID=$(curl -sS -X POST "$WORKER_URL/share" \
  -H "Content-Type: application/json" \
  -d '{"trip":{"name":"Smoke Test"},"activities":[]}' | node -e "const d = JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.id || '');")

# 讀取快照
curl -sS "$WORKER_URL/share/$SHARE_ID"
```

---

## 🧯 常見問題排錯 (Troubleshooting)

| 現象 / HTTP 狀態碼 | 常見原因 | 解法 |
| :--- | :--- | :--- |
| **`500` KV namespace `SHARED_TRIPS` 未綁定** | `wrangler.toml` 綁定名稱錯誤或 Dashboard 未綁定 KV | 確認 Binding Variable name 嚴格為 `SHARED_TRIPS`（全大寫），且 `/api/v1/health` 回傳 `"kvBound": true`。 |
| **`401 Unauthorized`** | 未帶金鑰、金鑰拼錯，或 `API_SECRET_TOKEN` 設在 GitHub Secrets 而未設在 Cloudflare Worker Secrets | 至 Cloudflare Dashboard → Worker → **Settings → Variables and Secrets** 設定 `API_SECRET_TOKEN`。 |
| **`403 Forbidden`** | 使用了子金鑰 (Sub-Key) 但缺少對應 `permissions`（如 `write`/`delete`/`admin`）或頻道不在 `allowedChannels` 白名單 | 呼叫 `/api/v1/whoami` 確認目前金鑰的 `role`、`permissions` 與 `allowedChannels`。 |
| **`429 Too Many Requests`** | 同 IP 認證失敗次數過多（防暴力破解保護：60 秒內觸發過多 `401`） | 確認金鑰正確，並依回應 Header `Retry-After: 60` 等待冷卻後重試。 |
| **瀏覽器前端 CORS 錯誤** | 前端網域不在 `ALLOWED_ORIGINS` 白名單內 | 至 Cloudflare Worker 環境變數新增 `ALLOWED_ORIGINS`，加入您的前端來源（不含結尾斜線，例如 `https://yourname.github.io`）。 |
| **前端分享按鈕顯示 🔒 或無法同步** | 前端未設定 `VITE_FLIGHT_PROXY_URL` | 在 GitHub Actions Variables 填入 `VITE_FLIGHT_PROXY_URL` 並重新觸發建置。 |

---

## 分享機制說明

| 項目 | 說明 |
|---|---|
| **有效期** | 唯讀分享快照 (`/share`) 有效期為 **30 天**（到期 KV 自動刪除）；Ingest 頻道資料 (`/api/v1/ingest`) 預設為 **90 天**滑動過期。 |
| **連結格式** | `https://<your-domain>/light-trip-plan/?view=<UUID>` |
| **安全性** | 唯讀存取且支援分享範圍過濾（`shareScopes`），僅暴露使用者勾選的分類快照；後續本地修改不會影響已分享的連結。 |
