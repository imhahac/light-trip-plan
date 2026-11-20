/**
 * Cloudflare Worker for Reverse Ticket Manager (RTM)
 *
 * ── 功能一：航班 API 代理 (HTTPS + 參數安全編碼) ────────────────────────────
 * GET /?api=aviationstack&flight=CI101
 * GET /?api=airlabs&flight=CI101
 *
 * ── 功能二：受保護的行程快照分享 (KV) ─────────────────────────────────────────
 * POST /share        Body: JSON 行程快照 (上限 512KB，可選 Token 授權) → 回傳 { id: UUID }
 * GET  /share/:id   → 回傳之前存入的行程快照 JSON
 *
 * ── 功能三：具備認證機制的外部寫入與雲端同步 API (KV) ─────────────────────────
 * POST   /api/v1/ingest   Body: 單筆或整包行程 JSON (需 Bearer Token 或 X-API-Key)
 * GET    /api/v1/ingest   讀取雲端通道最新資料 (支援 ?channel=default&sinceRevision=0)
 * DELETE /api/v1/ingest   清空指定雲端通道資料
 *
 * 環境變數（Secrets）：
 *   AVIATIONSTACK_API_KEY  - AviationStack 金鑰
 *   AIRLABS_API_KEY        - AirLabs 金鑰
 *   API_SECRET_TOKEN       - 外部寫入/讀取 API 授權金鑰 (若未設定則 fallback 至 SHARE_SECRET_TOKEN)
 *   SHARE_SECRET_TOKEN     - [選配] 分享端點授權金鑰
 *   ALLOWED_ORIGINS        - [選配] 允許存取的來源清單 (以逗號分隔)
 *
 * KV Namespace 綁定（wrangler.toml）：
 *   SHARED_TRIPS  - 用於分享與 API 同步功能的 KV namespace
 */

function uuid() {
  return crypto.randomUUID();
}

const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB 上限防護
const API_KV_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 天有效期

/**
 * 常數時間字串比對，防範時序旁路攻擊 (Timing Attack)
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/**
 * 從 Request Header 提取認證 Token (支援 Authorization: Bearer <TOKEN>、X-API-Key、X-Share-Token)
 */
function extractAuthToken(request) {
  const authHeader = request.headers.get("Authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch && bearerMatch[1]) return bearerMatch[1].trim();
  const apiKey = request.headers.get("X-API-Key") || "";
  if (apiKey.trim()) return apiKey.trim();
  const shareToken = request.headers.get("X-Share-Token") || "";
  return shareToken.trim();
}

/**
 * 規範化通道名稱 (僅允許英數字、底線與連字號，最長 64 字元)
 */
function sanitizeChannel(raw) {
  const cleaned = String(raw || "default").trim();
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(cleaned)) return cleaned;
  return "default";
}

/**
 * 依 id 合併陣列（若傳入項目無 id 則自動補上 UUID）
 */
function mergeItemsById(existingArr = [], incomingArr = [], prefix = "item") {
  const safeExisting = Array.isArray(existingArr) ? existingArr : [];
  const safeIncoming = Array.isArray(incomingArr) ? incomingArr : [];
  const map = new Map();

  safeExisting.forEach((item) => {
    if (item && typeof item === "object") {
      const id = String(item.id || `${prefix}_${uuid()}`);
      map.set(id, { ...item, id });
    }
  });

  safeIncoming.forEach((item) => {
    if (item && typeof item === "object") {
      const id = String(item.id || `${prefix}_${uuid()}`);
      const prev = map.get(id) || {};
      map.set(id, { ...prev, ...item, id });
    }
  });

  return Array.from(map.values());
}

/**
 * 將外部傳入的單筆簡寫 (ticket / hotel / activity / place...) 或整包 JSON 合併至既有雲端狀態
 */
export function mergeIngestPayload(existingPayload = {}, incomingRaw = {}, mode = "merge") {
  const incoming = { ...incomingRaw };

  // 支援單筆簡寫欄位自動轉為陣列
  const singularMappings = [
    ["ticket", "tickets"],
    ["hotel", "hotels"],
    ["activity", "activities"],
    ["place", "places"],
    ["day", "days"],
    ["reservation", "reservations"],
    ["expense", "expenses"],
    ["packingItem", "packingItems"],
    ["todo", "todos"],
  ];

  for (const [singular, plural] of singularMappings) {
    if (incoming[singular] && typeof incoming[singular] === "object" && !Array.isArray(incoming[singular])) {
      incoming[plural] = [
        ...(Array.isArray(incoming[plural]) ? incoming[plural] : []),
        incoming[singular],
      ];
      delete incoming[singular];
    }
  }

  const base = mode === "replace" || !existingPayload || typeof existingPayload !== "object"
    ? {}
    : existingPayload;

  const arrayFields = [
    ["tickets", "ticket"],
    ["hotels", "hotel"],
    ["activities", "act"],
    ["places", "place"],
    ["days", "day"],
    ["reservations", "res"],
    ["expenses", "exp"],
    ["packingItems", "pack"],
    ["todos", "todo"],
  ];

  const merged = {
    schemaVersion: 2,
    ...(base.trip || incoming.trip
      ? { trip: mode === "replace" ? incoming.trip : { ...(base.trip || {}), ...(incoming.trip || {}) } }
      : {}),
    tripLabels: mode === "replace"
      ? (incoming.tripLabels || {})
      : { ...(base.tripLabels || {}), ...(incoming.tripLabels || {}) },
    tripBudgets: mode === "replace"
      ? (incoming.tripBudgets || {})
      : { ...(base.tripBudgets || {}), ...(incoming.tripBudgets || {}) },
    tripOverrides: mode === "replace"
      ? (incoming.tripOverrides || { version: 1, segTripId: {}, removedSegIds: [], tripOrder: [] })
      : {
          version: 1,
          segTripId: { ...(base.tripOverrides?.segTripId || {}), ...(incoming.tripOverrides?.segTripId || {}) },
          removedSegIds: Array.from(
            new Set([...(base.tripOverrides?.removedSegIds || []), ...(incoming.tripOverrides?.removedSegIds || [])])
          ),
          tripOrder: incoming.tripOverrides?.tripOrder?.length
            ? incoming.tripOverrides.tripOrder
            : (base.tripOverrides?.tripOrder || []),
        },
  };

  for (const [field, prefix] of arrayFields) {
    if (mode === "replace") {
      merged[field] = Array.isArray(incoming[field])
        ? mergeItemsById([], incoming[field], prefix)
        : [];
    } else if (Array.isArray(incoming[field])) {
      merged[field] = mergeItemsById(base[field], incoming[field], prefix);
    } else if (Array.isArray(base[field])) {
      merged[field] = base[field];
    } else {
      merged[field] = [];
    }
  }

  return merged;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";
    const apiType = url.searchParams.get("api");
    const rawFlightNo = url.searchParams.get("flight");

    // 嚴格 CORS 標頭控制
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Share-Token",
      "X-Content-Type-Options": "nosniff"
    };

    // CORS 預檢
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });

    // ── 路由 /api/v1/ingest (或 /api/v1/sync) — 帶認證的外部寫入與前端同步接口 ──
    if (url.pathname === "/api/v1/ingest" || url.pathname === "/api/v1/sync") {
      if (!env.SHARED_TRIPS) {
        return json({ error: "KV namespace SHARED_TRIPS 未綁定" }, 500);
      }

      const expectedToken = env.API_SECRET_TOKEN || env.SHARE_SECRET_TOKEN;
      if (!expectedToken) {
        return json(
          { error: "伺服器尚未配置 API_SECRET_TOKEN (或 SHARE_SECRET_TOKEN)，拒絕未受保護的 API 存取" },
          503
        );
      }

      const providedToken = extractAuthToken(request);
      if (!providedToken || !timingSafeEqualStr(providedToken, expectedToken)) {
        return json(
          { error: "未授權存取 (401 Unauthorized)：請於 Authorization: Bearer <TOKEN> 或 X-API-Key 提供有效金鑰" },
          401
        );
      }

      const queryChannel = url.searchParams.get("channel");

      // 1. GET /api/v1/ingest — 讀取雲端通道目前資料 (供前端自動拉取或外部查詢)
      if (request.method === "GET") {
        const channel = sanitizeChannel(queryChannel);
        const kvKey = `api_sync:${channel}`;
        const rawStored = await env.SHARED_TRIPS.get(kvKey);

        if (!rawStored) {
          return json({
            success: true,
            channel,
            revision: 0,
            updatedAt: null,
            hasUpdate: false,
            data: null,
          });
        }

        let storedObj;
        try {
          storedObj = JSON.parse(rawStored);
        } catch {
          return json({ error: "雲端通道資料損毀" }, 500);
        }

        const currentRevision = Number(storedObj.revision) || 1;
        const sinceRevParam = url.searchParams.get("sinceRevision");
        const sinceRevision = sinceRevParam !== null && sinceRevParam !== "" ? Number(sinceRevParam) : -1;

        if (sinceRevision >= currentRevision) {
          return json({
            success: true,
            channel,
            revision: currentRevision,
            updatedAt: storedObj.updatedAt || null,
            snapshotId: storedObj.snapshotId || null,
            hasUpdate: false,
          });
        }

        return json({
          success: true,
          channel,
          revision: currentRevision,
          updatedAt: storedObj.updatedAt || null,
          snapshotId: storedObj.snapshotId || null,
          hasUpdate: true,
          data: storedObj.payload || storedObj,
        });
      }

      // 2. POST / PUT /api/v1/ingest — 外部寫入資料 (支援單筆追加 merge 或整包覆寫 replace)
      if (request.method === "POST" || request.method === "PUT") {
        const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
        if (contentLength > MAX_PAYLOAD_BYTES) {
          return json({ error: "承載資料過大 (Payload Too Large，上限 512KB)" }, 413);
        }

        let parsedBody;
        try {
          const rawText = await request.text();
          if (rawText.length > MAX_PAYLOAD_BYTES) {
            return json({ error: "承載資料過大 (上限 512KB)" }, 413);
          }
          parsedBody = JSON.parse(rawText);
        } catch (e) {
          return json({ error: "無效的 JSON 格式: " + e.message }, 400);
        }

        if (!parsedBody || typeof parsedBody !== "object") {
          return json({ error: "無效的 JSON：根節點必須是物件或陣列" }, 400);
        }

        const normalizedInput = Array.isArray(parsedBody) ? { tickets: parsedBody } : parsedBody;
        const channel = sanitizeChannel(normalizedInput.channel || queryChannel);
        const mode = (normalizedInput.mode || url.searchParams.get("mode") || (request.method === "PUT" ? "replace" : "merge")) === "replace"
          ? "replace"
          : "merge";

        const kvKey = `api_sync:${channel}`;
        let existingRecord = { revision: 0, payload: {} };

        if (mode === "merge") {
          const rawExisting = await env.SHARED_TRIPS.get(kvKey);
          if (rawExisting) {
            try {
              const parsedExisting = JSON.parse(rawExisting);
              existingRecord = {
                revision: Number(parsedExisting.revision) || 0,
                payload: parsedExisting.payload || parsedExisting || {},
              };
            } catch {
              existingRecord = { revision: 0, payload: {} };
            }
          }
        } else {
          const rawExisting = await env.SHARED_TRIPS.get(kvKey);
          if (rawExisting) {
            try {
              const parsedExisting = JSON.parse(rawExisting);
              existingRecord.revision = Number(parsedExisting.revision) || 0;
            } catch {
              existingRecord.revision = 0;
            }
          }
        }

        const mergedPayload = mergeIngestPayload(existingRecord.payload, normalizedInput, mode);
        const nextRevision = existingRecord.revision + 1;
        const updatedAt = new Date().toISOString();
        const snapshotId = uuid();

        const recordToSave = {
          channel,
          revision: nextRevision,
          updatedAt,
          snapshotId,
          payload: mergedPayload,
        };

        // 寫入雲端同步通道 + 同時產生一鍵匯入快照 UUID
        await Promise.all([
          env.SHARED_TRIPS.put(kvKey, JSON.stringify(recordToSave), { expirationTtl: API_KV_TTL_SECONDS }),
          env.SHARED_TRIPS.put(snapshotId, JSON.stringify(mergedPayload), { expirationTtl: 60 * 60 * 24 * 30 }),
        ]);

        return json({
          success: true,
          channel,
          mode,
          revision: nextRevision,
          updatedAt,
          snapshotId,
          magicImportQuery: `?magic=${snapshotId}`,
          shareViewQuery: `?view=${snapshotId}`,
          summary: {
            tickets: mergedPayload.tickets?.length || 0,
            hotels: mergedPayload.hotels?.length || 0,
            activities: mergedPayload.activities?.length || 0,
            places: mergedPayload.places?.length || 0,
            days: mergedPayload.days?.length || 0,
            reservations: mergedPayload.reservations?.length || 0,
            expenses: mergedPayload.expenses?.length || 0,
            packingItems: mergedPayload.packingItems?.length || 0,
            todos: mergedPayload.todos?.length || 0,
          },
        });
      }

      // 3. DELETE /api/v1/ingest — 清空指定雲端同步通道
      if (request.method === "DELETE") {
        const channel = sanitizeChannel(queryChannel);
        const kvKey = `api_sync:${channel}`;
        await env.SHARED_TRIPS.delete(kvKey);
        return json({
          success: true,
          channel,
          cleared: true,
        });
      }

      return json({ error: `不支援的 HTTP 方法: ${request.method}` }, 405);
    }

    // ── 路由 /share ──────────────────────────────────────────────────────────
    if (url.pathname === "/share" && request.method === "POST") {
      if (!env.SHARED_TRIPS) {
        return json({ error: "KV namespace SHARED_TRIPS 未綁定" }, 500);
      }

      // 1. 驗證 Authorization (若 Worker 配置了 SHARE_SECRET_TOKEN)
      if (env.SHARE_SECRET_TOKEN) {
        const authHeader = request.headers.get("Authorization") || "";
        const customToken = request.headers.get("X-Share-Token") || "";
        const token = authHeader.replace(/^Bearer\s+/i, "") || customToken;
        if (token !== env.SHARE_SECRET_TOKEN) {
          return json({ error: "未授權存取：缺少有效的分享金鑰" }, 401);
        }
      }

      // 2. 嚴格檢查 Content-Length 防範 DoS
      const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
      if (contentLength > MAX_PAYLOAD_BYTES) {
        return json({ error: "承載資料過大 (Payload Too Large，上限 512KB)" }, 413);
      }

      try {
        const body = await request.text();
        if (body.length > MAX_PAYLOAD_BYTES) {
          return json({ error: "承載資料過大 (上限 512KB)" }, 413);
        }

        // 3. 驗證是合法結構化 JSON 物件
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object') {
          return json({ error: "無效的 JSON：根節點必須是物件" }, 400);
        }

        const id = uuid();
        // 有效期 30 天（秒數）
        await env.SHARED_TRIPS.put(id, JSON.stringify(parsed), { expirationTtl: 60 * 60 * 24 * 30 });
        return json({ id });
      } catch (e) {
        return json({ error: "無效的 JSON 格式: " + e.message }, 400);
      }
    }

    if (url.pathname.startsWith("/share/") && request.method === "GET") {
      if (!env.SHARED_TRIPS) {
        return json({ error: "KV namespace SHARED_TRIPS 未綁定" }, 500);
      }
      const id = url.pathname.replace("/share/", "").trim();
      if (!id || !/^[0-9a-fA-F-]{36}$/.test(id)) {
        return json({ error: "無效的分享識別碼 ID (必須為 UUID 格式)" }, 400);
      }

      const data = await env.SHARED_TRIPS.get(id);
      if (!data) return json({ error: "分享連結已過期或不存在" }, 404);
      return new Response(data, {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ── 功能一：短網址邊緣還原代理 ──────────────────────────────────────────
    if (apiType === 'unshorten') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return json({ error: "缺少必要的 'url' 參數" }, 400);
      }

      // SSRF 防護：驗證協議與禁止存取內網/私有 IP
      try {
        const parsed = new URL(targetUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          return json({ error: "不支援的協議，僅允許 HTTP/HTTPS" }, 400);
        }
        const hostname = parsed.hostname.toLowerCase();
        if (
          hostname === 'localhost' ||
          hostname.endsWith('.localhost') ||
          hostname === '127.0.0.1' ||
          hostname === '::1' ||
          hostname === '0.0.0.0' ||
          hostname.startsWith('169.254.') ||
          hostname.startsWith('10.') ||
          hostname.startsWith('192.168.') ||
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
        ) {
          return json({ error: "禁止存取本機、內網或私有 IP 網址" }, 403);
        }
      } catch (_) {
        return json({ error: "無效的 URL 格式" }, 400);
      }

      try {
        const resp = await fetch(targetUrl, { redirect: "follow" });
        return json({ success: true, resolvedUrl: resp.url });
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // ── 功能二：航班 API 代理 (強制走 HTTPS 與參數 URL 編碼) ──────────────────
    if (!rawFlightNo) {
      return json({ error: "缺少必要的 'api' 或 'flight' 參數" }, 400);
    }

    // 參數安全清理與編碼
    const flightNo = encodeURIComponent(rawFlightNo.trim().toUpperCase());
    let targetUrl = "";

    try {
      if (apiType === 'aviationstack') {
        if (!env.AVIATIONSTACK_API_KEY) throw new Error("Worker 環境變數遺失: AVIATIONSTACK_API_KEY");
        // 修正：強制採用 HTTPS 協議
        targetUrl = `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(env.AVIATIONSTACK_API_KEY)}&flight_iata=${flightNo}`;
      } else if (apiType === 'airlabs') {
        if (!env.AIRLABS_API_KEY) throw new Error("Worker 環境變數遺失: AIRLABS_API_KEY");
        targetUrl = `https://airlabs.co/api/v9/routes?api_key=${encodeURIComponent(env.AIRLABS_API_KEY)}&flight_iata=${flightNo}`;
      } else {
        return json({ error: "參數 'api' 無效。請使用 'unshorten'、'aviationstack' 或 'airlabs'" }, 400);
      }

      const response = await fetch(targetUrl);
      const data = await response.json();
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });

    } catch (error) {
      return json({ error: error.message }, 500);
    }
  }
};
