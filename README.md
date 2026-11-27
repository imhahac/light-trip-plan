# 🧭 Light Trip Plan (智能離線旅遊規劃系統)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/Node.js-18%2B-brightgreen)](https://nodejs.org/)
[![React 18](https://img.shields.io/badge/React-18.2-blue)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-7.3-purple)](https://vitejs.dev/)
[![Tests](https://img.shields.io/badge/Tests-28%20Test%20Suites-emerald)](https://vitest.dev/)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-orange)](https://web.dev/progressive-web-apps/)
[![IndexedDB](https://img.shields.io/badge/Storage-IndexedDB%20v4%20(19%20Stores)-indigo)](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
[![Worker API](https://img.shields.io/badge/Worker%20API-v2.1%20OpenAPI%203.1-cyan)](./cloudflare-worker/API_GUIDE.md)

> **Light Trip Plan** 是一套專為進階旅人、戶外健行/公路旅行玩家、商務出差與外站機票愛好者打造的 **100% Client-Side 離線優先 (Offline-First)** 智慧旅遊規劃、向量地圖路線求解與多幣別清帳平台。
> 全系統無中心資料庫依賴，隱私 100% 本地留存，支援 **繁體中文 / English / 日本語** 三語介面，並提供選配之 **Cloudflare Worker API v2.1** 供外部 cURL / AI Agent / 自動化腳本雙向同步。

🔗 **[線上體驗 Demo](https://imhahac.github.io/light-trip-plan/)**

---

## 🌟 四大核心工作台與協作生態 (Core Workspaces)

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         Light Trip Plan (Light TREK)                       │
├───────────────────┬───────────────────┬────────────────┬───────────────────┤
│  🗺️ 行程與地圖     │   💰 財務與清帳    │   🎒 整備與協作 │  🎟️ 票券與憑證    │
│  - 雙欄拖曳/跨日  │   - 多幣別匯率凍結 │   - 分袋重量滾動 │  - 16 種通用預訂  │
│  - 3D 向量地圖    │   - 多人墊付分帳   │   - 待辦到期提醒 │  - 多段航班/轉機  │
│  - 逐段 OSRM/公車 │   - 個人花費統計   │   - 500MB 續傳   │  - PKPass / PDF   │
│  - 2-opt TSP 演算 │   - 結算日誌       │   - 旅伴協作看板 │  - 匯入審閱步驟   │
│  - GPX 坡度/收藏  │   - BYOK AI 收據   │   - 離線衝突解決 │  - 外站票閉環拆解 │
└───────────────────┴───────────────────┴────────────────┴───────────────────┘
```

### 1. 🗺️ 智能行程規劃與戶外向量地圖 (Planning & Map Workspace)
* **MapLibre GL JS + OpenFreeMap 3D 向量圖資**：免商業 Token、支援 **3D DEM 地形起伏**、地標聚類、實拍照片標記（Photo Markers），以及點擊地圖 POI 一鍵加入指定日程。
* **原生拖曳排序與 Undo / Redo**：支援同日拖曳重排與**跨日拖曳移動**，並結合 IndexedDB 持久化復原/重做堆疊。
* **Per-Leg OSRM 逐段實際路徑 & 2-opt TSP 最佳化**：逐段計算步行 / 單車 / 開車實際道路距離與時間（逾時自動降級 Haversine），並可一鍵以 2-opt TSP 演算法最佳化當日動線。
* **Transitous 多段大眾運輸轉乘 & 7 大導航跳轉**：自動查詢每段連續點對點之大眾運輸轉乘路線，並支援 Google Maps、Apple Maps、Naver Maps、KakaoMap、高德、OsmAnd、Maps.me 一鍵外部導航。
* **GPX 專業戶外工具與 Saved Tours 收藏庫**：純前端解析 GPX 1.1 / KML / KMZ 與 Google / Naver Maps 短網址；支援 **GPX 坡度著色**、海拔剖面圖、多軌跡比對、**沿途 500m 走廊 POI 搜尋**，以及持久化 GPX 軌跡收藏庫 (`savedTours`)。
* **景點評分、照片與行程複用**：支援 1–5★ 評分、壓縮實拍照片留存、Road Trip 公路模式、一鍵複製行程 (`duplicateTrip`)，以及單一或跨全部行程匯出 RFC 5545 `.ics` 行事曆。
* **Open-Meteo 16 天氣象與歷史回溯** + **維基百科圖文富化** + **可自訂章節之出版級 A4 PDF 手冊 / Markdown 匯出**。

### 2. 💰 多幣別財務與智慧清帳 (Finance Workspace)
* **Frankfurter API 匯率凍結**：記帳當下即時鎖定國際匯率（Frozen Rate），支援預訂費用自動連動。
* **多付款人分帳 & 最大餘數法 (Largest Remainder Method)**：支援多人同時墊付、自訂分攤對象，精準計算至最小貨幣單位不留尾差。
* **個人花費統計 & Settle-up 結算日誌**：即時檢視各成員「已墊付 / 應負擔 / 淨差額」，並提供最小轉帳次數撮合演算法與歷史結算紀錄 (`settlementLogs`)。
* **BYOK AI 收據掃描**：支援使用者自備金鑰（Gemini / OpenAI，金鑰僅存本機）拍照辨識收據金額、幣別與品項。
* **UTF-8 BOM CSV 匯出**：相容繁體中文 Excel 一鍵匯出開銷明細。

### 3. 🎒 整備中心、離線同步與非同步協作 (Preparation & Collab)
* **智慧分袋行李清單**：內建氣候範本、三層能見度過濾與**分袋重量滾動統計**。
* **行前待辦任務 (Todos)**：支援負責人指派、優先級分類與**每次工作階段到期自動提醒**。
* **非同步旅伴協作看板 (`CollabPanel`)**：支援留言討論、投票提案與狀態追蹤，並可透過 Worker API 同步。
* **離線優先同步與衝突解決**：內建離線寫入佇列 (`syncOutbox`)、**手動離線模式**、CORS 安全圖磚快取，以及同步衝突時之 **`Keep-Mine / Keep-Theirs`** 視覺化決策視窗。
* **細粒度唯讀分享 (`shareScopes`)**：分享連結時可自訂暴露範圍（行程、住宿、票券、費用等），唯讀檢視者畫面會自動隱藏未授權分頁。
* **500MB 大檔直傳 Google Drive + 軟刪除垃圾桶 (`fileTrash`)**：採用 Google Drive Resumable API 斷點續傳與一鍵還原。

### 4. 🎟️ 雙軌票券憑證與個人化體驗 (Tickets & Personalization)
* **16 種通用預訂 + 匯入前審閱步驟 (Review Step)**：純前端解析 Apple Wallet `.pkpass` 與 PDF 憑證，匯入前提供欄位預覽、自然鍵 (`confirmationCode`) 查重與費用連動勾選。
* **多段航班時區與轉機時間**：內建 7,917+ 全球機場離線座標與 IANA 時區庫（懶載入），自動計算實際飛行時長與跨航段轉機（Layover）時間，並支援外站票閉環拆解。
* **三語系與深度個人化**：完整支援 **繁體中文 / English / 日本語**；提供深淺色主題 (`Light / Dark / System`)、7 種強調色、字體大小/排版密度/減少動態效果、可自訂儀表板元件，以及 `?` 快捷鍵說明視窗。

---

## 🏗️ 系統架構概念 (System Architecture)

```mermaid
graph TD
    UI[Light Trip Plan SPA / PWA - 3-Lang & Theme] --> Context[React Context / Undo-Redo / Outbox]
    Context --> DB[(IndexedDB v4 - 19 Stores 本地優先)]
    Context --> OfflineAirport[(7,917+ 全球機場離線庫 - Lazy IANA)]

    UI --> MapEngine[MapLibre 3D + OSRM + Transitous + 2-opt TSP]
    UI --> Ingestion[PKPass / PDF / GPX / KML / BYOK AI Receipt]

    Context -. 選擇性邊緣代理 & 雙向同步 .-> CFWorker[Cloudflare Worker API v2.1]
    CFWorker -. KV Append-Only Inbox / Sub-Keys / Export .-> ExtClients[cURL / AI Agents / LINE Bot]
    CFWorker -. 512KB限制 / CORS白名單 / SSRF防禦 .-> ExtAPI[Aviation / AirLabs / Unshorten]

    Context -. OAuth 2.0 直連 .-> GDrive[(Google Drive 加密備份 / 500MB 續傳)]
    Context -. 匯出 .-> ExportEngine[A4 PDF 手冊 / .ics / GPX 1.1 / CSV]
```

### 資料儲存核心 (`treklite_db` — IndexedDB v4 / 19 Stores)
全系統採用 `idb` 封裝與跨 Store 原子交易，徹底突破 `localStorage` 5MB 上限：
* **核心行程與日程**：`trips`、`dayPlans`、`placeItems`、`dayNotes`、`savedTours`（GPX 軌跡收藏庫）
* **票券與憑證**：`reservations`、`tickets`、`hotels`、`activities`
* **財務與清帳**：`expenses`、`settlementLogs`
* **整備與檔案**：`packingItems`、`todos`、`attachedFiles`、`fileTrash`
* **同步、協作與設定**：`syncOutbox`、`collabItems`、`backups`、`appSettings`

---

## 🛠️ 開發與環境建置 (Quick Start)

### 1. 本地啟動
```bash
# 安裝依賴
npm install

# 啟動本地開發伺服器 (Vite)
npm run dev

# 執行生產打包測試
npm run build
```

### 2. 品質門禁與自動化測試 (CI Gate)
本專案透過 `.github/workflows/deploy.yml` 執行嚴格發布門禁（通過後才會部署 GitHub Pages 與 Cloudflare Worker）：
```bash
# 靜態代碼檢查 (強制 0 錯誤、0 警告)
npm run lint

# 單元與整合測試 (28 個測試套件)
npm test

# Worker 腳本語法檢查
node --check cloudflare-worker/worker.js
```

---

## 🔐 隱私、資安與 Cloudflare Worker API v2.1

1. **零追蹤、零中心儲存**：旅客之航班、護照、住宿與花費 100% 留存於個人裝置 IndexedDB，BYOK AI 金鑰僅存本機不經中繼。
2. **Cloudflare Worker API v2.1 安全閘道**：
   * **Append-Only Inbox + 多頻道同步**：支援 `POST` / `PUT` / `PATCH`（局部合併）/ `DELETE`（單筆或全頻道）、`?dryRun=true` 試跑、`X-Idempotency-Key` 冪等防重與樂觀鎖 (`If-Match` / `baseRevision`)。
   * **多格式直接匯出與規格自省**：內建 `/api/v1/export?format=csv|ics|gpx`、`/api/v1/health`、`/api/v1/whoami` 與 `/api/v1/openapi.json`（OpenAPI 3.1）。
   * **分權子金鑰與零停機輪替**：支援逗號分隔多把 Master Key 與 `/api/v1/keys` 建立限定頻道、權限 (`read/write/delete`) 與有效期的 Sub-Key。
   * **邊緣安全加固**：512KB Payload 上限、`ALLOWED_ORIGINS` CORS 白名單、防暴力破解速率限制 (`429`)、短網址還原 SSRF 內網阻斷，以及選配 `SHARE_SECRET_TOKEN` / `REQUIRE_PROXY_AUTH`。
3. **崩潰自癒與診斷包**：Error Boundary 提供一鍵下載除錯診斷包（含 IndexedDB 健康狀態與錯誤堆疊）與強制清除重設機制。

---

## 📖 部署與 API 使用文件
詳細之 Cloudflare Worker、GitHub Pages、Google OAuth 憑證、LINE Bot 排程與外部 API v2.1 規格，請參閱：
* 👉 **[完整生產環境部署指南 (deployment.md)](./deployment.md)**
* 👉 **[外部寫入與雲端自動同步 API v2.1 使用指南 (cloudflare-worker/API_GUIDE.md)](./cloudflare-worker/API_GUIDE.md)**
* 👉 **[Cloudflare Worker KV 部署與驗證手冊 (cloudflare-worker/CLOUDFLARE_KV_DEPLOY.md)](./cloudflare-worker/CLOUDFLARE_KV_DEPLOY.md)**

---

## 授權條款
本專案採用 [MIT License](LICENSE) 授權。
