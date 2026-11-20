/**
 * ingestApiService.js
 * 具備認證機制的外部寫入 API 客戶端與雲端同步服務：
 * - 支援 Authorization: Bearer <TOKEN> 與 X-API-Key 雙標頭認證
 * - 支援外部單筆追加 (merge) 或整包覆寫 (replace) 寫入 Cloudflare Worker KV
 * - 支援前端開頁／重新整理自動拉取最新寫入版本 (revision 比對)
 */

import { STORAGE_KEYS } from '../../constants/storageKeys';

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
        importMode: 'replace', // 'merge' | 'replace'
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
