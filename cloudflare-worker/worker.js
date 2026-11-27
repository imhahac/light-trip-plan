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
const SUBKEYS_REGISTRY_KV_KEY = "api_keys:registry";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://imhahac.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_REDIRECT_HOPS = 5;

/**
 * 結構化資安稽核日誌（嚴禁輸出任何明文 Token / Credential）
 */
function auditLog(event, meta = {}) {
  try {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      service: "light-trip-plan-worker",
      event,
      ...meta,
    }));
  } catch {
    // ignore logging failure
  }
}

/**
 * 依據 env.ALLOWED_ORIGINS 白名單解析 CORS Origin（不再反射任意惡意 Origin）
 */
export function resolveAllowedCorsOrigin(requestOrigin, env = {}) {
  if (!requestOrigin) return "null";
  const normalizedReq = String(requestOrigin).trim().replace(/\/+$/, "").toLowerCase();
  const configured = env.ALLOWED_ORIGINS
    ? String(env.ALLOWED_ORIGINS)
        .split(",")
        .map((o) => o.trim().replace(/\/+$/, "").toLowerCase())
        .filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS;

  if (configured.includes("*")) return "*";
  if (configured.includes(normalizedReq)) return requestOrigin;
  return "null";
}

/**
 * 嚴格驗證 URL 是否為公開網際網路位址（防範 SSRF、302 內網跳轉、IPv6 私有段、八進位/整數 IP）
 */
export function validateSafePublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, status: 400, error: "無效的 URL 格式" };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { safe: false, status: 400, error: "不支援的協議，僅允許 HTTP/HTTPS" };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "::" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("169.254.") ||
    hostname.startsWith("0.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
    /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(hostname) ||
    /^::ffff:/i.test(hostname) ||
    /^(fc|fd|fe[89ab])[0-9a-f]{2}:/i.test(hostname) ||
    /^\d+$/.test(hostname) ||
    /^0x[0-9a-f]+$/i.test(hostname) ||
    /^0\d+\./.test(hostname)
  ) {
    return { safe: false, status: 403, error: "禁止存取本機、內網、雲端 Metadata 或私有 IP 網址" };
  }

  return { safe: true, url: parsed.toString() };
}

/**
 * 具備逾時控制之上游 fetch
 */
async function fetchWithTimeout(targetUrl, init = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(targetUrl, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const ALLOWED_ITEM_TYPES = new Set([
  "tickets", "hotels", "activities", "places", "days",
  "reservations", "expenses", "packingItems", "todos", "collabItems",
]);

// 有界記憶體級認證失敗頻率限制器（零 KV 寫入；僅針對帶有真實 Client IP 的請求，不汙染本機單元測試）
const MAX_TRACKED_IPS = 2000;
const AUTH_RATE_WINDOW_MS = 60 * 1000;
const AUTH_RATE_MAX_FAILURES = 20;
const authFailureBuckets = new Map();

function getClientIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp && cfIp.trim()) return cfIp.trim();
  const xff = request.headers.get("X-Forwarded-For");
  if (xff && xff.trim()) return xff.split(",")[0].trim();
  return null;
}

function isAuthRateLimited(request) {
  const ip = getClientIp(request);
  if (!ip) return false;
  const now = Date.now();
  const rec = authFailureBuckets.get(ip);
  if (!rec) return false;
  if (now - rec.windowStart > AUTH_RATE_WINDOW_MS) {
    authFailureBuckets.delete(ip);
    return false;
  }
  return rec.count >= AUTH_RATE_MAX_FAILURES;
}

function recordAuthFailure(request) {
  const ip = getClientIp(request);
  if (!ip) return;
  const now = Date.now();
  if (authFailureBuckets.size >= MAX_TRACKED_IPS && !authFailureBuckets.has(ip)) {
    for (const [k, v] of authFailureBuckets.entries()) {
      if (now - v.windowStart > AUTH_RATE_WINDOW_MS) authFailureBuckets.delete(k);
    }
    if (authFailureBuckets.size >= MAX_TRACKED_IPS) {
      const oldestKey = authFailureBuckets.keys().next().value;
      if (oldestKey) authFailureBuckets.delete(oldestKey);
    }
  }
  const rec = authFailureBuckets.get(ip);
  if (!rec || now - rec.windowStart > AUTH_RATE_WINDOW_MS) {
    authFailureBuckets.set(ip, { count: 1, windowStart: now });
  } else {
    rec.count += 1;
  }
}

function escapeCsvCell(val) {
  let str = String(val ?? "");
  // 防範 Excel CSV Formula Injection
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

function escapeXml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeIcs(val) {
  return String(val ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function summarizeIngestPayload(payload = {}) {
  return {
    tickets: payload?.tickets?.length || 0,
    hotels: payload?.hotels?.length || 0,
    activities: payload?.activities?.length || 0,
    places: payload?.places?.length || 0,
    days: payload?.days?.length || 0,
    reservations: payload?.reservations?.length || 0,
    expenses: payload?.expenses?.length || 0,
    packingItems: payload?.packingItems?.length || 0,
    todos: payload?.todos?.length || 0,
    collabItems: payload?.collabItems?.length || 0,
  };
}

function filterIngestPayload(payload = {}, { types = null, date = null } = {}) {
  const out = {};
  const allowedTypes = types ? new Set(types) : null;
  const matchDate = (item) => {
    if (!date) return true;
    const candidates = [
      item?.date, item?.startDate, item?.endDate, item?.outboundDate,
      item?.returnDate, item?.checkIn, item?.checkOut, item?.dueDate,
      item?.flightDetails?.departureTime, item?.accommodationDetails?.checkInDate,
    ].filter(Boolean).map((d) => String(d).slice(0, 10));
    return candidates.includes(date);
  };

  if (!allowedTypes && payload.trip) out.trip = payload.trip;
  for (const field of ALLOWED_ITEM_TYPES) {
    if (allowedTypes && !allowedTypes.has(field)) continue;
    const arr = Array.isArray(payload[field]) ? payload[field] : [];
    out[field] = date ? arr.filter(matchDate) : arr;
  }
  return out;
}

function buildCsvExport(payload = {}) {
  const expenses = Array.isArray(payload.expenses) ? payload.expenses : [];
  const header = ["id", "date", "title", "category", "amount", "currency", "baseAmount", "baseCurrency", "paidBy", "settled"];
  const rows = [header.map(escapeCsvCell).join(",")];
  for (const e of expenses) {
    rows.push([
      e.id, e.date || "", e.title || "", e.category || "",
      e.amount ?? "", e.currency || "", e.baseAmount ?? "", e.baseCurrency || "",
      e.paidBy || "", e.settled ? "true" : "false",
    ].map(escapeCsvCell).join(","));
  }
  return `\uFEFF${rows.join("\r\n")}`;
}

function buildGpxExport(payload = {}, channel = "default") {
  const pts = [
    ...(Array.isArray(payload.places) ? payload.places : []),
    ...(Array.isArray(payload.activities) ? payload.activities : []),
    ...(Array.isArray(payload.hotels) ? payload.hotels : []),
  ].filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)) && !(Number(p.lat) === 0 && Number(p.lng) === 0));

  const wpts = pts.map((p) =>
    `  <wpt lat="${Number(p.lat).toFixed(6)}" lon="${Number(p.lng).toFixed(6)}"><name>${escapeXml(p.name || p.title || "Waypoint")}</name></wpt>`
  ).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="LightTripPlan-Worker">\n  <metadata><name>${escapeXml(payload.trip?.title || channel)}</name></metadata>\n${wpts}\n</gpx>`;
}

function buildIcsExport(payload = {}, channel = "default") {
  const nowStamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LightTripPlan//Worker Export//EN",
    `X-WR-CALNAME:${escapeIcs(payload.trip?.title || channel)}`,
  ];
  const pushEvent = (uid, dateStr, summary, desc = "") => {
    if (!dateStr) return;
    const clean = String(dateStr).slice(0, 10).replace(/-/g, "");
    if (!/^\d{8}$/.test(clean)) return;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcs(uid)}@light-trip-plan`);
    lines.push(`DTSTAMP:${nowStamp}`);
    lines.push(`DTSTART;VALUE=DATE:${clean}`);
    lines.push(`DTEND;VALUE=DATE:${clean}`);
    lines.push(`SUMMARY:${escapeIcs(summary)}`);
    if (desc) lines.push(`DESCRIPTION:${escapeIcs(desc)}`);
    lines.push("END:VEVENT");
  };
  (payload.activities || []).forEach((a, i) => pushEvent(`act_${a.id || i}`, a.startDate || a.date, a.title || a.name || "Activity", a.notes || ""));
  (payload.reservations || []).forEach((r, i) => pushEvent(`res_${r.id || i}`, r.startDate || r.flightDetails?.departureTime || r.accommodationDetails?.checkInDate, r.title || "Reservation", r.confirmationCode ? `Code: ${r.confirmationCode}` : ""));
  (payload.todos || []).forEach((td, i) => pushEvent(`todo_${td.id || i}`, td.dueDate, `Todo: ${td.title || ""}`, ""));
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function buildOpenApiSpec(origin) {
  return {
    openapi: "3.1.0",
    info: { title: "Light Trip Plan Worker API", version: "2.1.0" },
    servers: [{ url: origin }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
      },
    },
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    paths: {
      "/api/v1/health": { get: { summary: "Health check (public)", security: [] } },
      "/api/v1/whoami": { get: { summary: "Inspect current Master Token or Sub-Key permissions" } },
      "/api/v1/channels": { get: { summary: "List active sync channels (Master Admin only)" } },
      "/api/v1/ingest": {
        get: { summary: "Read channel data (supports sinceRevision, summaryOnly, type, date)" },
        post: { summary: "Append/merge items into channel (supports X-Idempotency-Key, dryRun, createSnapshot)" },
        put: { summary: "Replace full channel snapshot" },
        patch: { summary: "Partially update existing items by id" },
        delete: { summary: "Delete a single item (?type=&id=) or clear channel (requires delete permission)" },
      },
      "/api/v1/ingest/compact": { post: { summary: "Manually compact channel inbox into single snapshot" } },
      "/api/v1/export": { get: { summary: "Export channel directly as ics, gpx, csv, or json" } },
      "/api/v1/keys": {
        get: { summary: "List sub-keys (Master Admin only)" },
        post: { summary: "Issue scoped sub-key (Master Admin only)" },
        delete: { summary: "Revoke sub-key by ?id= (Master Admin only)" },
      },
    },
  };
}

/**
 * 讀取並依時序重播 Append-Only Inbox 事件（消除 KV 併發讀寫 Lost Update，支援 Tombstone 與手動 Compaction）
 */
async function replayChannelInbox(kv, channel, { forceCompact = false } = {}) {
  const inboxPrefix = `api_inbox:${channel}:`;
  const legacyKey = `api_sync:${channel}`;
  let eventKeys = [];

  if (typeof kv.list === "function") {
    let cursor;
    do {
      const page = await kv.list({ prefix: inboxPrefix, cursor });
      if (Array.isArray(page?.keys)) {
        eventKeys.push(...page.keys.map((k) => k.name));
      }
      cursor = page?.list_complete ? undefined : page?.cursor;
    } while (cursor);
  }

  eventKeys.sort(); // 零補齊時間戳前綴保證嚴格時序

  if (eventKeys.length === 0) {
    // 向下相容：讀取舊版單鍵 api_sync:<channel>
    const rawLegacy = await kv.get(legacyKey);
    if (!rawLegacy) {
      return { revision: 0, updatedAt: null, snapshotId: null, payload: null, tombstones: [], compactedCount: 0 };
    }
    try {
      const parsedLegacy = JSON.parse(rawLegacy);
      return {
        revision: Number(parsedLegacy.revision) || 1,
        updatedAt: parsedLegacy.updatedAt || null,
        snapshotId: parsedLegacy.snapshotId || null,
        payload: parsedLegacy.payload || parsedLegacy,
        tombstones: Array.isArray(parsedLegacy.tombstones) ? parsedLegacy.tombstones : [],
        compactedCount: 0,
      };
    } catch {
      return { revision: 0, updatedAt: null, snapshotId: null, payload: null, tombstones: [], compactedCount: 0 };
    }
  }

  // 讀取既有基底快照（支援歷史版本或自動壓縮後的 checkpoint）
  let baseRevision = 0;
  let state = {};
  let seenKeys = new Set();
  let tombstones = [];
  let latestUpdatedAt = null;
  let latestSnapshotId = null;

  const baseRaw = await kv.get(`api_sync:${channel}`);
  if (baseRaw) {
    try {
      const baseRecord = JSON.parse(baseRaw);
      baseRevision = Number(baseRecord.revision || 0);
      state = baseRecord.payload || {};
      latestUpdatedAt = baseRecord.updatedAt || null;
      latestSnapshotId = baseRecord.snapshotId || null;
      if (Array.isArray(baseRecord.seenIdempotencyKeys)) {
        seenKeys = new Set(baseRecord.seenIdempotencyKeys.slice(-200));
      }
      if (Array.isArray(baseRecord.tombstones)) {
        tombstones = baseRecord.tombstones.slice(-200);
      }
    } catch {
      // ignore malformed base
    }
  }

  // 批次讀取所有 Inbox 事件
  const rawEvents = await Promise.all(eventKeys.map((k) => kv.get(k)));
  const events = rawEvents
    .map((raw) => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // 去重（支援離線 Outbox X-Idempotency-Key 冪等重播）
  const uniqueEvents = [];
  for (const ev of events) {
    if (ev.idempotencyKey) {
      if (seenKeys.has(ev.idempotencyKey)) continue;
      seenKeys.add(ev.idempotencyKey);
    }
    uniqueEvents.push(ev);
  }

  // 從最後一次 replace checkpoint 開始重播，大幅加速讀取
  let startIdx = 0;
  let hasReplace = false;
  for (let i = uniqueEvents.length - 1; i >= 0; i--) {
    if (uniqueEvents[i].mode === "replace") {
      startIdx = i;
      hasReplace = true;
      break;
    }
  }
  if (hasReplace) {
    state = {};
    tombstones = [];
  }

  for (let i = startIdx; i < uniqueEvents.length; i++) {
    const ev = uniqueEvents[i];
    if (ev.mode === "delete_item" && ev.targetType && ev.targetId) {
      if (Array.isArray(state[ev.targetType])) {
        state[ev.targetType] = state[ev.targetType].filter((item) => String(item?.id) !== String(ev.targetId));
      }
      tombstones.push({ type: ev.targetType, id: String(ev.targetId), deletedAt: ev.createdAt || null });
    } else {
      state = mergeIngestPayload(state, ev.payload || {}, ev.mode === "replace" ? "replace" : "merge");
    }
  }

  const latest = uniqueEvents[uniqueEvents.length - 1];
  const totalRevision = baseRevision + uniqueEvents.length;
  const finalUpdatedAt = latest?.createdAt || latestUpdatedAt;
  const finalSnapshotId = latest?.snapshotId || latestSnapshotId;
  const cappedTombstones = tombstones.slice(-200);

  // Auto-Compaction（達 20 筆或手動 forceCompact 時壓縮回單一快照鍵）
  if ((eventKeys.length >= 20 || (forceCompact && eventKeys.length > 0))) {
    const compacted = {
      revision: totalRevision,
      updatedAt: finalUpdatedAt,
      snapshotId: finalSnapshotId,
      payload: state,
      seenIdempotencyKeys: Array.from(seenKeys).slice(-200),
      tombstones: cappedTombstones,
    };
    await kv.put(`api_sync:${channel}`, JSON.stringify(compacted), {
      expirationTtl: API_KV_TTL_SECONDS,
    });
    await Promise.all(eventKeys.map((k) => kv.delete(k)));
    auditLog("inbox_compacted", { channel, compactedEvents: eventKeys.length, revision: totalRevision });
  }

  return {
    revision: totalRevision,
    updatedAt: finalUpdatedAt,
    snapshotId: finalSnapshotId,
    payload: state,
    tombstones: cappedTombstones,
    compactedCount: eventKeys.length,
  };
}

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
 * 計算字串之 SHA-256 Hex 雜湊（子金鑰僅於 KV 儲存雜湊值，不落盤明文）
 */
async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input || ""));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 產生高強度子金鑰明文 (僅於簽發當下回傳一次)
 */
function generateSubKeyToken() {
  const part1 = uuid().replace(/-/g, "");
  const part2 = uuid().replace(/-/g, "").slice(0, 16);
  return `ltp_sk_${part1}${part2}`;
}

/**
 * 產生遮罩顯示字串 (例如 ltp_sk_9f8a...3c1d)
 */
function maskToken(rawToken) {
  const s = String(rawToken || "");
  if (s.length <= 14) return `${s.slice(0, 4)}...`;
  return `${s.slice(0, 11)}...${s.slice(-4)}`;
}

async function loadSubKeysRegistry(kv) {
  const raw = await kv.get(SUBKEYS_REGISTRY_KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveSubKeysRegistry(kv, list) {
  await kv.put(SUBKEYS_REGISTRY_KV_KEY, JSON.stringify(list));
}

/**
 * 解析環境變數中的 Master Token 清單（支援以逗號分隔多組靜態 Master Token）
 */
function getMasterTokens(env) {
  const rawMaster = env.API_SECRET_TOKEN || env.SHARE_SECRET_TOKEN || "";
  return String(rawMaster)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 驗證請求 Token（同時支援 Master Token 清單與 KV 動態子金鑰）
 */
async function authenticateApiRequest(request, env) {
  const masterTokens = getMasterTokens(env);
  if (masterTokens.length === 0) {
    return {
      ok: false,
      status: 503,
      error: "伺服器尚未配置 API_SECRET_TOKEN (或 SHARE_SECRET_TOKEN)，拒絕未受保護的 API 存取",
    };
  }

  const providedToken = extractAuthToken(request);
  if (!providedToken) {
    return {
      ok: false,
      status: 401,
      error: "未授權存取 (401 Unauthorized)：請於 Authorization: Bearer <TOKEN> 或 X-API-Key 提供有效金鑰",
    };
  }

  // 1. 先比對是否為 Master Token (支援多組逗號分隔之管理員金鑰)
  for (const master of masterTokens) {
    if (timingSafeEqualStr(providedToken, master)) {
      return {
        ok: true,
        role: "admin",
        keyId: "master",
        label: "Master Admin Token",
        permissions: ["read", "write", "delete", "admin"],
        allowedChannels: ["*"],
      };
    }
  }

  // 2. 再比對 KV 子金鑰註冊表 (以 SHA-256 雜湊比對)
  if (env.SHARED_TRIPS) {
    const tokenHash = await sha256Hex(providedToken);
    const registry = await loadSubKeysRegistry(env.SHARED_TRIPS);
    const matched = registry.find((k) => k && k.tokenHash && timingSafeEqualStr(k.tokenHash, tokenHash));

    if (matched) {
      if (matched.expiresAt && new Date(matched.expiresAt).getTime() < Date.now()) {
        return {
          ok: false,
          status: 401,
          error: `未授權存取：子金鑰「${matched.label || matched.id}」已過期`,
        };
      }
      return {
        ok: true,
        role: "subkey",
        keyId: matched.id,
        label: matched.label || matched.id,
        permissions: Array.isArray(matched.permissions) ? matched.permissions : ["read", "write"],
        allowedChannels: Array.isArray(matched.allowedChannels) && matched.allowedChannels.length > 0
          ? matched.allowedChannels
          : ["*"],
      };
    }
  }

  return {
    ok: false,
    status: 401,
    error: "未授權存取 (401 Unauthorized)：無效或已撤銷的 API 金鑰",
  };
}

/**
 * 檢查金鑰是否具備指定動作與通道之權限
 */
function checkKeyAuthorization(auth, requiredPermission, targetChannel = "default") {
  if (!auth?.ok) {
    return { allowed: false, status: auth?.status || 401, error: auth?.error || "未授權" };
  }
  if (auth.role === "admin") {
    return { allowed: true };
  }
  const channels = auth.allowedChannels || ["*"];
  if (!channels.includes("*") && !channels.includes(targetChannel)) {
    return {
      allowed: false,
      status: 403,
      error: `權限不足 (403 Forbidden)：子金鑰「${auth.label}」未獲授權存取通道 "${targetChannel}"`,
    };
  }
  const perms = auth.permissions || [];
  if (!perms.includes(requiredPermission) && !perms.includes("admin")) {
    return {
      allowed: false,
      status: 403,
      error: `權限不足 (403 Forbidden)：子金鑰「${auth.label}」缺少 "${requiredPermission}" 權限`,
    };
  }
  return { allowed: true };
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
    ["collabItem", "collabItems"],
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
    ["collabItems", "collab"],
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
    const requestOrigin = request.headers.get("Origin");
    const allowedOrigin = resolveAllowedCorsOrigin(requestOrigin, env);
    const apiType = url.searchParams.get("api");
    const rawFlightNo = url.searchParams.get("flight");

    // 嚴格 CORS 標頭控制（依據 ALLOWED_ORIGINS 白名單，同步放行 PATCH 與 X-Idempotency-Key）
    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key, X-Share-Token, X-Idempotency-Key",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    };

    // CORS 預檢
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const json = (data, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders, ...extraHeaders }
      });

    // ── 公開診斷與規格端點 (零 KV 寫入) ──────────────────────────────────────
    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "light-trip-plan-worker",
        version: "2.1.0",
        kvBound: Boolean(env.SHARED_TRIPS),
        ts: new Date().toISOString(),
      });
    }

    if (url.pathname === "/api/v1/openapi.json" && request.method === "GET") {
      return json(buildOpenApiSpec(url.origin));
    }

    // ── 認證失敗速率限制檢查（僅對 /api/v1/* 保護端點） ──────────────────────
    if (url.pathname.startsWith("/api/v1/") && isAuthRateLimited(request)) {
      auditLog("rate_limited", { path: url.pathname, method: request.method });
      return json(
        { error: "認證失敗次數過多，請稍後再試 (429 Too Many Requests)" },
        429,
        { "Retry-After": "60" }
      );
    }

    // ── 路由 /api/v1/whoami — 檢驗當前 Master Token 或子金鑰權限與到期日 ───────
    if (url.pathname === "/api/v1/whoami" && request.method === "GET") {
      const auth = await authenticateApiRequest(request, env);
      if (!auth.ok) {
        if (auth.status === 401) recordAuthFailure(request);
        auditLog("auth_failed", { path: url.pathname, method: "GET", status: auth.status });
        return json({ error: auth.error }, auth.status);
      }
      return json({
        success: true,
        role: auth.role,
        keyId: auth.keyId,
        label: auth.label,
        permissions: auth.permissions,
        allowedChannels: auth.allowedChannels,
        expiresAt: auth.expiresAt || null,
      });
    }

    // ── 路由 /api/v1/channels — 列出活躍同步通道 (僅 Master Token，嚴格排除系統鍵) ──
    if (url.pathname === "/api/v1/channels" && request.method === "GET") {
      if (!env.SHARED_TRIPS) return json({ error: "KV namespace SHARED_TRIPS 未綁定" }, 500);
      const auth = await authenticateApiRequest(request, env);
      if (!auth.ok) {
        if (auth.status === 401) recordAuthFailure(request);
        return json({ error: auth.error }, auth.status);
      }
      if (auth.role !== "admin") {
        return json({ error: "權限不足 (403 Forbidden)：僅限 Master Admin Token 可查詢通道清單" }, 403);
      }
      const channels = new Set();
      if (typeof env.SHARED_TRIPS.list === "function") {
        for (const prefix of ["api_sync:", "api_inbox:"]) {
          let cursor;
          do {
            const page = await env.SHARED_TRIPS.list({ prefix, cursor });
            for (const k of page?.keys || []) {
              const name = k.name || "";
              if (name.startsWith("api_sync:")) {
                const ch = name.slice("api_sync:".length);
                if (ch) channels.add(ch);
              } else if (name.startsWith("api_inbox:")) {
                const rest = name.slice("api_inbox:".length);
                const ch = rest.split(":")[0];
                if (ch) channels.add(ch);
              }
            }
            cursor = page?.list_complete ? undefined : page?.cursor;
          } while (cursor);
        }
      }
      return json({ success: true, channels: Array.from(channels).sort() });
    }

    // ── 路由 /api/v1/ingest/compact — 手動壓縮指定通道 Inbox ─────────────────
    if (url.pathname === "/api/v1/ingest/compact" && request.method === "POST") {
      if (!env.SHARED_TRIPS) return json({ error: "KV namespace SHARED_TRIPS 未綁定" }, 500);
      const auth = await authenticateApiRequest(request, env);
      if (!auth.ok) {
        if (auth.status === 401) recordAuthFailure(request);
        return json({ error: auth.error }, auth.status);
      }
      const channel = sanitizeChannel(url.searchParams.get("channel"));
      const access = checkKeyAuthorization(auth, "write", channel);
      if (!access.allowed) return json({ error: access.error }, access.status);
      const replayed = await replayChannelInbox(env.SHARED_TRIPS, channel, { forceCompact: true });
      return json({
        success: true,
        channel,
        revision: replayed.revision,
        compactedEvents: replayed.compactedCount || 0,
      });
    }

    // ── 路由 /api/v1/export — 直接匯出 ics / gpx / csv / json ─────────────────
    if (url.pathname === "/api/v1/export" && request.method === "GET") {
      if (!env.SHARED_TRIPS) return json({ error: "KV namespace SHARED_TRIPS 未綁定" }, 500);
      const auth = await authenticateApiRequest(request, env);
      if (!auth.ok) {
        if (auth.status === 401) recordAuthFailure(request);
        return json({ error: auth.error }, auth.status);
      }
      const channel = sanitizeChannel(url.searchParams.get("channel"));
      const access = checkKeyAuthorization(auth, "read", channel);
      if (!access.allowed) return json({ error: access.error }, access.status);

      const format = (url.searchParams.get("format") || "json").toLowerCase();
      const replayed = await replayChannelInbox(env.SHARED_TRIPS, channel);
      const payload = replayed.payload || {};

      if (format === "csv") {
        return new Response(buildCsvExport(payload), {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${channel}-expenses.csv"`,
            ...corsHeaders,
          },
        });
      }
      if (format === "gpx") {
        return new Response(buildGpxExport(payload, channel), {
          status: 200,
          headers: {
            "Content-Type": "application/gpx+xml; charset=utf-8",
            "Content-Disposition": `attachment; filename="${channel}.gpx"`,
            ...corsHeaders,
          },
        });
      }
      if (format === "ics") {
        return new Response(buildIcsExport(payload, channel), {
          status: 200,
          headers: {
            "Content-Type": "text/calendar; charset=utf-8",
            "Content-Disposition": `attachment; filename="${channel}.ics"`,
            ...corsHeaders,
          },
        });
      }
      return new Response(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${channel}.json"`,
          ...corsHeaders,
        },
      });
    }

    // ── 路由 /api/v1/keys — 子金鑰簽發、清單查詢與撤銷管理接口 (僅限 Master Token) ──
    if (url.pathname === "/api/v1/keys") {
      if (!env.SHARED_TRIPS) {
        return json({ error: "KV namespace SHARED_TRIPS 未綁定" }, 500);
      }

      const auth = await authenticateApiRequest(request, env);
      if (!auth.ok) {
        auditLog("auth_failed", { path: url.pathname, method: request.method, status: auth.status });
        return json({ error: auth.error }, auth.status);
      }
      if (auth.role !== "admin") {
        auditLog("authz_denied", { path: url.pathname, method: request.method, keyId: auth.keyId, label: auth.label });
        return json({ error: "權限不足 (403 Forbidden)：僅限 Master Admin Token 可管理或簽發子金鑰" }, 403);
      }

      // 1. GET /api/v1/keys — 列出所有已簽發的子金鑰 (僅回傳遮罩與權限設定，不回傳雜湊或明文)
      if (request.method === "GET") {
        const registry = await loadSubKeysRegistry(env.SHARED_TRIPS);
        const now = Date.now();
        const safeKeys = registry.map((k) => ({
          id: k.id,
          label: k.label,
          tokenMask: k.tokenMask,
          permissions: k.permissions || ["read", "write"],
          allowedChannels: k.allowedChannels || ["*"],
          createdAt: k.createdAt,
          expiresAt: k.expiresAt || null,
          isExpired: Boolean(k.expiresAt && new Date(k.expiresAt).getTime() < now),
        }));
        return json({ success: true, keys: safeKeys });
      }

      // 2. POST /api/v1/keys — 簽發新子金鑰 (明文 token 僅在建立當下回傳一次)
      if (request.method === "POST") {
        let body = {};
        try {
          body = await request.json();
        } catch {
          return json({ error: "無效的 JSON 請求內容" }, 400);
        }

        const label = String(body.label || "").trim() || `SubKey-${new Date().toISOString().slice(0, 10)}`;
        const validPerms = ["read", "write", "delete"];
        const rawPerms = Array.isArray(body.permissions) ? body.permissions : ["read", "write"];
        const permissions = rawPerms.filter((p) => validPerms.includes(p));
        if (permissions.length === 0) permissions.push("read");

        const rawChannels = Array.isArray(body.allowedChannels)
          ? body.allowedChannels
          : typeof body.allowedChannels === "string"
            ? body.allowedChannels.split(",")
            : ["*"];
        const allowedChannels = rawChannels
          .map((c) => String(c || "").trim())
          .filter((c) => c === "*" || /^[a-zA-Z0-9_-]{1,64}$/.test(c));
        if (allowedChannels.length === 0) allowedChannels.push("*");

        const expiresInDays = Number(body.expiresInDays) || 0;
        const expiresAt = expiresInDays > 0
          ? new Date(Date.now() + expiresInDays * 86400 * 1000).toISOString()
          : null;

        const rawToken = generateSubKeyToken();
        const tokenHash = await sha256Hex(rawToken);
        const tokenMask = maskToken(rawToken);
        const id = `key_${uuid().slice(0, 12)}`;
        const createdAt = new Date().toISOString();

        const registry = await loadSubKeysRegistry(env.SHARED_TRIPS);
        const newEntry = {
          id,
          label,
          tokenHash,
          tokenMask,
          permissions,
          allowedChannels,
          createdAt,
          expiresAt,
        };
        registry.push(newEntry);
        await saveSubKeysRegistry(env.SHARED_TRIPS, registry);
        auditLog("subkey_created", { keyId: id, label, permissions, allowedChannels, expiresAt });

        return json({
          success: true,
          key: {
            id,
            label,
            token: rawToken, // 僅此次回傳明文
            tokenMask,
            permissions,
            allowedChannels,
            createdAt,
            expiresAt,
          },
        });
      }

      // 3. DELETE /api/v1/keys?id=<keyId> — 立即撤銷指定子金鑰
      if (request.method === "DELETE") {
        let keyId = url.searchParams.get("id") || "";
        if (!keyId) {
          try {
            const body = await request.json();
            keyId = body?.id || "";
          } catch {
            keyId = "";
          }
        }
        keyId = String(keyId).trim();
        if (!keyId) {
          return json({ error: "請提供欲撤銷的子金鑰 id (?id=key_...)" }, 400);
        }

        const registry = await loadSubKeysRegistry(env.SHARED_TRIPS);
        const nextRegistry = registry.filter((k) => k && k.id !== keyId);
        if (nextRegistry.length === registry.length) {
          return json({ error: `找不到指定的子金鑰 (${keyId})` }, 404);
        }
        await saveSubKeysRegistry(env.SHARED_TRIPS, nextRegistry);
        auditLog("subkey_revoked", { revokedId: keyId, remainingCount: nextRegistry.length });
        return json({ success: true, revokedId: keyId, remainingCount: nextRegistry.length });
      }

      return json({ error: `不支援的 HTTP 方法: ${request.method}` }, 405);
    }

    // ── 路由 /api/v1/ingest (或 /api/v1/sync) — 帶認證的外部寫入與前端同步接口 ──
    if (url.pathname === "/api/v1/ingest" || url.pathname === "/api/v1/sync") {
      if (!env.SHARED_TRIPS) {
        return json({ error: "KV namespace SHARED_TRIPS 未綁定" }, 500);
      }

      const auth = await authenticateApiRequest(request, env);
      if (!auth.ok) {
        if (auth.status === 401) recordAuthFailure(request);
        auditLog("auth_failed", { path: url.pathname, method: request.method, status: auth.status });
        return json({ error: auth.error }, auth.status);
      }

      const queryChannel = url.searchParams.get("channel");

      // 1. GET /api/v1/ingest — 讀取並重播雲端 Append-Only Inbox 通道最新資料（支援 summaryOnly / type / date 篩選）
      if (request.method === "GET") {
        const channel = sanitizeChannel(queryChannel);
        const access = checkKeyAuthorization(auth, "read", channel);
        if (!access.allowed) {
          auditLog("authz_denied", { path: url.pathname, method: "GET", channel, keyId: auth.keyId });
          return json({ error: access.error }, access.status);
        }

        const replayed = await replayChannelInbox(env.SHARED_TRIPS, channel);
        if (!replayed.payload || replayed.revision === 0) {
          return json({
            success: true,
            channel,
            revision: 0,
            updatedAt: null,
            hasUpdate: false,
            data: null,
            tombstones: [],
          });
        }

        const currentRevision = replayed.revision;
        const sinceRevParam = url.searchParams.get("sinceRevision");
        const sinceRevision = sinceRevParam !== null && sinceRevParam !== "" ? Number(sinceRevParam) : -1;

        if (sinceRevision >= currentRevision) {
          return json({
            success: true,
            channel,
            revision: currentRevision,
            updatedAt: replayed.updatedAt,
            snapshotId: replayed.snapshotId,
            hasUpdate: false,
          });
        }

        const summaryOnly = url.searchParams.get("summaryOnly") === "true";
        if (summaryOnly) {
          return json({
            success: true,
            channel,
            revision: currentRevision,
            updatedAt: replayed.updatedAt,
            snapshotId: replayed.snapshotId,
            hasUpdate: true,
            summary: summarizeIngestPayload(replayed.payload),
            tombstoneCount: replayed.tombstones?.length || 0,
          });
        }

        const typeParam = (url.searchParams.get("type") || "").trim();
        const dateParam = (url.searchParams.get("date") || "").trim();
        const requestedTypes = typeParam
          ? typeParam.split(",").map((s) => s.trim()).filter((s) => ALLOWED_ITEM_TYPES.has(s))
          : null;
        const isFiltered = Boolean((requestedTypes && requestedTypes.length > 0) || dateParam);
        const responseData = isFiltered
          ? filterIngestPayload(replayed.payload, { types: requestedTypes, date: dateParam || null })
          : replayed.payload;

        return json({
          success: true,
          channel,
          revision: currentRevision,
          updatedAt: replayed.updatedAt,
          snapshotId: replayed.snapshotId,
          hasUpdate: true,
          ...(isFiltered ? { filtered: true, filters: { type: requestedTypes, date: dateParam || null } } : {}),
          data: responseData,
          tombstones: replayed.tombstones || [],
        });
      }

      // 2. POST / PUT / PATCH /api/v1/ingest — Append-Only Inbox 寫入（支援 PATCH 局部更新與 ?dryRun=true 試跑）
      if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
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
        const access = checkKeyAuthorization(auth, "write", channel);
        if (!access.allowed) {
          auditLog("authz_denied", { path: url.pathname, method: request.method, channel, keyId: auth.keyId });
          return json({ error: access.error }, access.status);
        }
        const mode = request.method === "PATCH"
          ? "merge"
          : (normalizedInput.mode || url.searchParams.get("mode") || (request.method === "PUT" ? "replace" : "merge")) === "replace"
            ? "replace"
            : "merge";
        const isDryRun = url.searchParams.get("dryRun") === "true" || normalizedInput.dryRun === true;
        const shouldCreateSnapshot =
          !isDryRun && (url.searchParams.get("createSnapshot") === "true" || normalizedInput.createSnapshot === true);

        if (isDryRun) {
          const current = await replayChannelInbox(env.SHARED_TRIPS, channel);
          const simulated = mergeIngestPayload(current.payload || {}, normalizedInput, mode);
          return json({
            success: true,
            dryRun: true,
            channel,
            mode,
            currentRevision: current.revision || 0,
            projectedSummary: summarizeIngestPayload(simulated),
          });
        }

        const eventId = uuid();
        const updatedAt = new Date().toISOString();
        const paddedTs = String(Date.now()).padStart(15, "0");
        const snapshotId = shouldCreateSnapshot ? uuid() : null;
        const rawIdemKey = (request.headers.get("X-Idempotency-Key") || "").trim();
        const idempotencyKey = rawIdemKey && /^[a-zA-Z0-9._:-]{1,64}$/.test(rawIdemKey) ? rawIdemKey : null;

        // 每個寫入事件寫入獨立 KV Key，完全避免併發 Read-Modify-Write 覆蓋
        const inboxEventKey = `api_inbox:${channel}:${paddedTs}_${eventId}`;
        const eventRecord = {
          id: eventId,
          channel,
          mode,
          idempotencyKey,
          createdAt: updatedAt,
          author: auth.label || auth.keyId,
          snapshotId,
          payload: normalizedInput,
        };

        await env.SHARED_TRIPS.put(inboxEventKey, JSON.stringify(eventRecord), {
          expirationTtl: API_KV_TTL_SECONDS,
        });

        // 重播目前通道狀態以計算回傳摘要與版本號
        const replayed = await replayChannelInbox(env.SHARED_TRIPS, channel);
        const mergedPayload = replayed.payload || mergeIngestPayload({}, normalizedInput, mode);
        const nextRevision = replayed.revision || 1;

        // 僅於明確要求 ?createSnapshot=true 時才建立無認證 30 天分享快照，避免機敏資料隱性暴露
        if (shouldCreateSnapshot && snapshotId) {
          await env.SHARED_TRIPS.put(snapshotId, JSON.stringify(mergedPayload), {
            expirationTtl: 60 * 60 * 24 * 30,
          });
        }

        auditLog("ingest_write", {
          channel,
          method: request.method,
          mode,
          revision: nextRevision,
          keyId: auth.keyId,
          author: auth.label,
          createdSnapshot: Boolean(snapshotId),
        });

        return json({
          success: true,
          channel,
          mode,
          revision: nextRevision,
          updatedAt,
          ...(snapshotId
            ? {
                snapshotId,
                magicImportQuery: `?magic=${snapshotId}`,
                shareViewQuery: `?view=${snapshotId}`,
              }
            : {}),
          summary: summarizeIngestPayload(mergedPayload),
        });
      }

      // 3. DELETE /api/v1/ingest — 單筆 Tombstone 刪除 (?type=&id=) 或清空整個通道（一律要求 delete 權限）
      if (request.method === "DELETE") {
        const channel = sanitizeChannel(queryChannel);
        const access = checkKeyAuthorization(auth, "delete", channel);
        if (!access.allowed) {
          auditLog("authz_denied", { path: url.pathname, method: "DELETE", channel, keyId: auth.keyId });
          return json({ error: access.error }, access.status);
        }

        const targetType = (url.searchParams.get("type") || "").trim();
        const targetId = (url.searchParams.get("id") || "").trim();
        if (targetType || targetId) {
          if (!ALLOWED_ITEM_TYPES.has(targetType) || !targetId) {
            return json({ error: "單筆刪除必須同時提供合法的 type（如 activities / expenses / todos）與 id" }, 400);
          }
          const eventId = uuid();
          const deletedAt = new Date().toISOString();
          const paddedTs = String(Date.now()).padStart(15, "0");
          const inboxEventKey = `api_inbox:${channel}:${paddedTs}_${eventId}`;
          await env.SHARED_TRIPS.put(inboxEventKey, JSON.stringify({
            id: eventId,
            channel,
            mode: "delete_item",
            targetType,
            targetId,
            createdAt: deletedAt,
            author: auth.label || auth.keyId,
          }), { expirationTtl: API_KV_TTL_SECONDS });

          const replayed = await replayChannelInbox(env.SHARED_TRIPS, channel);
          auditLog("ingest_item_deleted", { channel, targetType, targetId, revision: replayed.revision, keyId: auth.keyId });
          return json({
            success: true,
            channel,
            deleted: { type: targetType, id: targetId, deletedAt },
            revision: replayed.revision,
            summary: summarizeIngestPayload(replayed.payload || {}),
          });
        }

        const keysToDelete = [`api_sync:${channel}`];
        if (typeof env.SHARED_TRIPS.list === "function") {
          const inboxPrefix = `api_inbox:${channel}:`;
          let cursor;
          do {
            const page = await env.SHARED_TRIPS.list({ prefix: inboxPrefix, cursor });
            if (Array.isArray(page?.keys)) {
              keysToDelete.push(...page.keys.map((k) => k.name));
            }
            cursor = page?.list_complete ? undefined : page?.cursor;
          } while (cursor);
        }

        await Promise.all(keysToDelete.map((k) => env.SHARED_TRIPS.delete(k)));
        auditLog("ingest_cleared", { channel, deletedKeys: keysToDelete.length, keyId: auth.keyId });

        return json({
          success: true,
          channel,
          cleared: true,
          deletedEventsCount: Math.max(0, keysToDelete.length - 1),
        });
      }

      return json({ error: `不支援的 HTTP 方法: ${request.method}` }, 405);
    }

    // ── 路由 /share ──────────────────────────────────────────────────────────
    if (url.pathname === "/share" && request.method === "POST") {
      if (!env.SHARED_TRIPS) {
        return json({ error: "KV namespace SHARED_TRIPS 未綁定" }, 500);
      }

      // 1. 驗證 Authorization (若 Worker 配置了 SHARE_SECRET_TOKEN，採常數時間比對)
      if (env.SHARE_SECRET_TOKEN) {
        const token = extractAuthToken(request);
        if (!token || !timingSafeEqualStr(token, env.SHARE_SECRET_TOKEN)) {
          auditLog("share_auth_failed", { path: "/share" });
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

    // ── 功能一：短網址邊緣還原代理 (逐跳手動驗證防範 302 SSRF 繞過) ──────────
    if (apiType === 'unshorten') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return json({ error: "缺少必要的 'url' 參數" }, 400);
      }

      let currentUrl = targetUrl;
      try {
        for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
          const check = validateSafePublicUrl(currentUrl);
          if (!check.safe) {
            auditLog("ssrf_blocked", { hop, reason: check.error });
            return json({ error: check.error }, check.status);
          }

          const resp = await fetchWithTimeout(check.url, { redirect: "manual" }, UPSTREAM_TIMEOUT_MS);
          if (resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get("Location");
            if (!location) {
              return json({ success: true, resolvedUrl: check.url });
            }
            // 解析相對或絕對轉址目標，並於下一跳重新驗證 SSRF
            currentUrl = new URL(location, check.url).toString();
            continue;
          }
          return json({ success: true, resolvedUrl: resp.url || check.url });
        }
        return json({ error: "轉址次數過多，已中止還原" }, 400);
      } catch (error) {
        return json({ error: error.message }, 500);
      }
    }

    // ── 功能二：航班 API 代理 (強制走 HTTPS、逾時控制與參數 URL 編碼) ──────────
    // 若 Worker 啟用 REQUIRE_PROXY_AUTH="true"，強制驗證 API 金鑰防止第三方盜用付費額度
    if (env.REQUIRE_PROXY_AUTH === "true") {
      const proxyAuth = await authenticateApiRequest(request, env);
      if (!proxyAuth.ok) {
        auditLog("proxy_auth_failed", { apiType, status: proxyAuth.status });
        return json({ error: proxyAuth.error }, proxyAuth.status);
      }
    }

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

      const response = await fetchWithTimeout(targetUrl, {}, UPSTREAM_TIMEOUT_MS);
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
