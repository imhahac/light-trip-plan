/**
 * ingestApiService.js
 * 具備認證機制的外部寫入 API 客戶端與雲端同步服務：
 * - 支援 Authorization: Bearer <TOKEN> 與 X-API-Key 雙標頭認證
 * - 支援外部單筆追加 (merge) 或整包覆寫 (replace) 寫入 Cloudflare Worker KV
 * - 支援前端開頁／重新整理自動拉取最新寫入版本 (revision 比對)
 */

import { STORAGE_KEYS } from '../../constants/storageKeys.js';
import { isEffectivelyOffline } from '../sync/offlineModeService.js';

const DEFAULT_WORKER_BASE = (
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FLIGHT_PROXY_URL) ||
    'https://flight-api-proxy.imhahac.workers.dev'
).replace(/\/+$/, '');

export function getDefaultApiSyncConfig() {
    return {
        endpointUrl: DEFAULT_WORKER_BASE,
        apiToken: '',
        channel: 'default',
        autoPullOnLoad: true,
        importMode: 'merge', // 預設 'merge' 保護離線本地編輯不被覆寫
    };
}

export function getStoredApiSyncConfig() {
    const defaults = getDefaultApiSyncConfig();
    if (typeof window === 'undefined' || !window.localStorage) return defaults;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEYS.API_SYNC_CONFIG);
        if (!raw) return defaults;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return defaults;
        return {
            ...defaults,
            ...parsed,
            endpointUrl: String(parsed.endpointUrl || defaults.endpointUrl).replace(/\/+$/, ''),
            channel: String(parsed.channel || 'default').trim() || 'default',
        };
    } catch {
        return defaults;
    }
}

export function saveApiSyncConfig(config) {
    const merged = {
        ...getDefaultApiSyncConfig(),
        ...(config || {}),
    };
    merged.endpointUrl = String(merged.endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    merged.channel = String(merged.channel || 'default').trim() || 'default';
    if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEYS.API_SYNC_CONFIG, JSON.stringify(merged));
    }
    return merged;
}

export function getLastSyncedRevision(channel = 'default') {
    if (typeof window === 'undefined' || !window.localStorage) return 0;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEYS.API_SYNC_LAST_REVISION);
        if (!raw) return 0;
        const parsed = JSON.parse(raw);
        return Number(parsed?.[channel]) || 0;
    } catch {
        return 0;
    }
}

export function setLastSyncedRevision(channel = 'default', revision = 0) {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEYS.API_SYNC_LAST_REVISION);
        const map = raw ? JSON.parse(raw) : {};
        const next = { ...(map && typeof map === 'object' ? map : {}), [channel]: Number(revision) || 0 };
        window.localStorage.setItem(STORAGE_KEYS.API_SYNC_LAST_REVISION, JSON.stringify(next));
    } catch {
        // ignore storage errors
    }
}

function buildAuthHeaders(apiToken) {
    const cleanToken = String(apiToken || '').trim();
    if (!cleanToken) {
        throw new Error('請先設定 API Secret Token');
    }
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cleanToken}`,
        'X-API-Key': cleanToken,
    };
}

/**
 * 從雲端 API 通道拉取最新寫入的資料
 * @param {Object} params
 * @param {string} [params.endpointUrl]
 * @param {string} params.apiToken
 * @param {string} [params.channel='default']
 * @param {number} [params.sinceRevision=-1] 若傳入 >=0，僅在雲端版本大於 sinceRevision 時回傳 data
 */
export async function pullFromIngestApi({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken,
    channel = 'default',
    sinceRevision = -1,
}) {
    if (isEffectivelyOffline()) {
        return { success: true, channel, hasUpdate: false, offlineSkipped: true };
    }
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const headers = buildAuthHeaders(apiToken);
    const params = new URLSearchParams({
        channel: String(channel || 'default').trim() || 'default',
    });
    if (sinceRevision >= 0) {
        params.set('sinceRevision', String(sinceRevision));
    }

    const res = await fetch(`${base}/api/v1/ingest?${params.toString()}`, {
        method: 'GET',
        headers,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `API 讀取失敗 (HTTP ${res.status})`);
    }
    return data;
}

/**
 * 將行程或單筆項目寫入雲端 API 通道
 * @param {Object} params
 * @param {string} [params.endpointUrl]
 * @param {string} params.apiToken
 * @param {string} [params.channel='default']
 * @param {Object} params.payload
 * @param {'merge' | 'replace'} [params.mode='merge']
 */
export async function pushToIngestApi({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken,
    channel = 'default',
    payload,
    mode = 'merge',
}) {
    if (isEffectivelyOffline()) {
        const { enqueueOfflineWrite } = await import('../sync/offlineOutboxService');
        const entry = await enqueueOfflineWrite({
            channel,
            mode,
            payload,
            baseRevision: getLastSyncedRevision(channel),
            label: `離線寫入 (${channel})`,
        });
        return { success: true, channel, mode, queuedOffline: true, outboxId: entry.id, idempotencyKey: entry.idempotencyKey };
    }
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const headers = buildAuthHeaders(apiToken);
    const params = new URLSearchParams({
        channel: String(channel || 'default').trim() || 'default',
        mode: mode === 'replace' ? 'replace' : 'merge',
    });

    const res = await fetch(`${base}/api/v1/ingest?${params.toString()}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `API 寫入失敗 (HTTP ${res.status})`);
    }
    return data;
}

/**
 * 查詢所有已簽發的子金鑰清單（需使用 Master Admin Token）
 */
export async function listSubKeys({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken,
}) {
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const headers = buildAuthHeaders(apiToken);

    const res = await fetch(`${base}/api/v1/keys`, {
        method: 'GET',
        headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `查詢子金鑰失敗 (HTTP ${res.status})`);
    }
    return data.keys || [];
}

/**
 * 簽發一組新的子金鑰（需使用 Master Admin Token，明文 token 僅回傳一次）
 */
export async function createSubKey({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken,
    label,
    permissions = ['read', 'write'],
    allowedChannels = ['*'],
    expiresInDays = 0,
}) {
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const headers = buildAuthHeaders(apiToken);

    const res = await fetch(`${base}/api/v1/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            label,
            permissions,
            allowedChannels,
            expiresInDays: Number(expiresInDays) || 0,
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `簽發子金鑰失敗 (HTTP ${res.status})`);
    }
    return data.key;
}

/**
 * 撤銷（刪除）指定子金鑰（需使用 Master Admin Token）
 */
export async function revokeSubKey({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken,
    keyId,
}) {
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const headers = buildAuthHeaders(apiToken);
    const params = new URLSearchParams({ id: String(keyId || '').trim() });

    const res = await fetch(`${base}/api/v1/keys?${params.toString()}`, {
        method: 'DELETE',
        headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `撤銷子金鑰失敗 (HTTP ${res.status})`);
    }
    return data;
}

/**
 * 檢驗目前憑證（Master Token 或子金鑰）的角色、權限、允許通道與到期日 (GET /api/v1/whoami)
 */
export async function checkApiWhoAmI({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken,
}) {
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const headers = buildAuthHeaders(apiToken);
    const res = await fetch(`${base}/api/v1/whoami`, { method: 'GET', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `驗證失敗 (HTTP ${res.status})`);
    }
    return data;
}

/**
 * 局部更新雲端單筆項目 (PATCH /api/v1/ingest)
 */
export async function patchIngestItem({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken,
    channel = 'default',
    payload,
    dryRun = false,
}) {
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const headers = buildAuthHeaders(apiToken);
    const params = new URLSearchParams({
        channel: String(channel || 'default').trim() || 'default',
    });
    if (dryRun) params.set('dryRun', 'true');
    const res = await fetch(`${base}/api/v1/ingest?${params.toString()}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `局部更新失敗 (HTTP ${res.status})`);
    }
    return data;
}

/**
 * 單筆 Tombstone 刪除雲端指定項目 (DELETE /api/v1/ingest?type=&id=)
 */
export async function deleteIngestItem({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken,
    channel = 'default',
    type,
    id,
}) {
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const headers = buildAuthHeaders(apiToken);
    const params = new URLSearchParams({
        channel: String(channel || 'default').trim() || 'default',
        type: String(type || '').trim(),
        id: String(id || '').trim(),
    });
    const res = await fetch(`${base}/api/v1/ingest?${params.toString()}`, {
        method: 'DELETE',
        headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `單筆刪除失敗 (HTTP ${res.status})`);
    }
    return data;
}

/**
 * 產生分類式 cURL 範例（涵蓋快速寫入、PATCH/單筆刪除、篩選匯出、診斷與 OpenAPI）
 */
export function buildCategorizedCurlExamples({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken = '<YOUR_API_SECRET_TOKEN>',
    channel = 'default',
} = {}) {
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const tokenDisplay = String(apiToken || '').trim() || '<YOUR_API_SECRET_TOKEN>';
    const ch = String(channel || 'default').trim() || 'default';

    return {
        quick_write: `# 1. 單筆追加活動／景點（附 X-Idempotency-Key 防止重試重複寫入）
curl -X POST "${base}/api/v1/ingest?channel=${ch}&mode=merge" \\
  -H "Authorization: Bearer ${tokenDisplay}" \\
  -H "X-Idempotency-Key: act-20261225-dinner-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "activity": {
      "id": "act-2026-1225-dinner",
      "title": "六本木燒肉晚餐",
      "startDate": "2026-12-25",
      "time": "19:30",
      "lat": 35.6627,
      "lng": 139.7314
    }
  }'

# 2. 追加一筆消費或旅伴共筆投票
curl -X POST "${base}/api/v1/ingest?channel=${ch}&mode=merge" \\
  -H "Authorization: Bearer ${tokenDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "expense": { "id": "exp-ramen", "title": "一蘭拉麵", "amount": 1480, "currency": "JPY", "date": "2026-12-25" }
  }'`,

        patch_delete: `# 1. 局部更新 (PATCH)：將待辦標記為已完成（不覆蓋其他欄位）
curl -X PATCH "${base}/api/v1/ingest?channel=${ch}" \\
  -H "Authorization: Bearer ${tokenDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{ "todo": { "id": "todo-jr-pass", "isDone": true } }'

# 2. 寫入試跑驗證 (?dryRun=true，零 KV 寫入消耗)
curl -X POST "${base}/api/v1/ingest?channel=${ch}&dryRun=true" \\
  -H "Authorization: Bearer ${tokenDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{ "activity": { "id": "test-1", "title": "測試驗證" } }'

# 3. 單筆刪除 (Tombstone，需 delete 權限，不會清空整個通道)
curl -X DELETE "${base}/api/v1/ingest?channel=${ch}&type=activities&id=act-2026-1225-dinner" \\
  -H "Authorization: Bearer ${tokenDisplay}"`,

        query_export: `# 1. 僅讀取通道摘要筆數（省流量 / 省 AI Agent Token）
curl -X GET "${base}/api/v1/ingest?channel=${ch}&summaryOnly=true" \\
  -H "Authorization: Bearer ${tokenDisplay}"

# 2. 依類型與日期篩選讀取 (回傳標記 filtered: true)
curl -X GET "${base}/api/v1/ingest?channel=${ch}&type=activities,expenses&date=2026-12-25" \\
  -H "Authorization: Bearer ${tokenDisplay}"

# 3. 一行直接匯出標準行事曆 (.ics)、航跡 (.gpx) 或費用報表 (.csv)
curl -fsSL -H "Authorization: Bearer ${tokenDisplay}" "${base}/api/v1/export?channel=${ch}&format=ics" -o trip.ics
curl -fsSL -H "Authorization: Bearer ${tokenDisplay}" "${base}/api/v1/export?channel=${ch}&format=csv" -o expenses.csv
curl -fsSL -H "Authorization: Bearer ${tokenDisplay}" "${base}/api/v1/export?channel=${ch}&format=gpx" -o route.gpx`,

        admin_diag: `# 1. 公開健康檢查 (零認證) & OpenAPI 3.1 規格 (可匯入 Postman / n8n / AI Agent)
curl -s "${base}/api/v1/health"
curl -s "${base}/api/v1/openapi.json"

# 2. 檢驗目前 Token / 子金鑰身份、權限與到期日
curl -X GET "${base}/api/v1/whoami" \\
  -H "Authorization: Bearer ${tokenDisplay}"

# 3. 列出所有活躍同步通道 (僅 Master Token) & 手動壓縮 Inbox
curl -X GET "${base}/api/v1/channels" -H "Authorization: Bearer <MASTER_TOKEN>"
curl -X POST "${base}/api/v1/ingest/compact?channel=${ch}" -H "Authorization: Bearer ${tokenDisplay}"`,
    };
}

/**
 * 產生可直接給外部腳本 / iOS 捷徑 / AI Agent 使用的 curl 範例
 */
export function buildIngestCurlExamples({
    endpointUrl = DEFAULT_WORKER_BASE,
    apiToken = '<YOUR_API_SECRET_TOKEN>',
    channel = 'default',
} = {}) {
    const base = String(endpointUrl || DEFAULT_WORKER_BASE).replace(/\/+$/, '');
    const tokenDisplay = String(apiToken || '').trim() || '<YOUR_API_SECRET_TOKEN>';
    const ch = String(channel || 'default').trim() || 'default';

    return `# 1. 單筆追加活動／景點 (mode=merge，自動併入既有雲端資料並同步至每日排程)
curl -X POST "${base}/api/v1/ingest?channel=${ch}&mode=merge" \\
  -H "Authorization: Bearer ${tokenDisplay}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "activity": {
      "id": "act-2026-1225-dinner",
      "title": "六本木燒肉晚餐",
      "category": "dining",
      "startDate": "2026-12-25",
      "time": "19:30",
      "location": "六本木",
      "currency": "JPY",
      "exchangeRate": 0.22,
      "price": 8000,
      "priceTWD": 1760,
      "lat": 35.6627,
      "lng": 139.7314,
      "notes": "已預約 19:30 雙人位"
    }
  }'

# 2. 整包行程 JSON 覆寫寫入 (mode=replace，直接上傳完整 backup.json)
curl -X POST "${base}/api/v1/ingest?channel=${ch}&mode=replace" \\
  -H "X-API-Key: ${tokenDisplay}" \\
  -H "Content-Type: application/json" \\
  -d @trip-backup.json

# 3. 讀取目前雲端通道資料
curl -X GET "${base}/api/v1/ingest?channel=${ch}" \\
  -H "Authorization: Bearer ${tokenDisplay}"`;
}
