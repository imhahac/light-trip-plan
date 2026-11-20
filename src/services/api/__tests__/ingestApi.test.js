import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker, { mergeIngestPayload } from '../../../../cloudflare-worker/worker';
import {
    getStoredApiSyncConfig,
    saveApiSyncConfig,
    getLastSyncedRevision,
    setLastSyncedRevision,
    pullFromIngestApi,
    pushToIngestApi,
    buildIngestCurlExamples,
} from '../ingestApiService';

function createMockKV() {
    const store = new Map();
    return {
        store,
        get: vi.fn(async (key) => (store.has(key) ? store.get(key) : null)),
        put: vi.fn(async (key, value) => {
            store.set(key, String(value));
        }),
        delete: vi.fn(async (key) => {
            store.delete(key);
        }),
    };
}

describe('Cloudflare Worker /api/v1/ingest 認證寫入與前端同步測試', () => {
    let mockKV;
    let env;

    beforeEach(() => {
        window.localStorage.clear();
        mockKV = createMockKV();
        env = {
            SHARED_TRIPS: mockKV,
            API_SECRET_TOKEN: 'my-super-secret-token-2026',
        };
    });

    it('未帶 Token 或 Token 錯誤時應回傳 401 Unauthorized', async () => {
        const reqNoAuth = new Request('https://worker.example.com/api/v1/ingest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activity: { id: 'a1', title: 'Test' } }),
        });
        const resNoAuth = await worker.fetch(reqNoAuth, env);
        expect(resNoAuth.status).toBe(401);

        const reqWrongAuth = new Request('https://worker.example.com/api/v1/ingest', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer wrong-token',
            },
            body: JSON.stringify({ activity: { id: 'a1', title: 'Test' } }),
        });
        const resWrongAuth = await worker.fetch(reqWrongAuth, env);
        expect(resWrongAuth.status).toBe(401);
    });

    it('支援 Authorization: Bearer <TOKEN> 與 X-API-Key 單筆追加 (merge) 及整包覆寫 (replace)', async () => {
        // 1. 第一次寫入：使用 Bearer Token 寫入一張機票與一間飯店
        const req1 = new Request('https://worker.example.com/api/v1/ingest?channel=tokyo2026', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer my-super-secret-token-2026',
            },
            body: JSON.stringify({
                ticket: {
                    id: 't-1',
                    airline: 'China Airlines',
                    outboundDate: '2026-12-23',
                    inboundDate: '2027-01-03',
                    priceTWD: 17823,
                },
                hotel: {
                    id: 'h-1',
                    name: '東橫INN 東京日本橋馬喰町',
                    checkIn: '2026-12-23',
                    checkOut: '2026-12-24',
                    priceTWD: 1781,
                },
            }),
        });

        const res1 = await worker.fetch(req1, env);
        expect(res1.status).toBe(200);
        const body1 = await res1.json();
        expect(body1.success).toBe(true);
        expect(body1.channel).toBe('tokyo2026');
        expect(body1.revision).toBe(1);
        expect(body1.summary.tickets).toBe(1);
        expect(body1.summary.hotels).toBe(1);
        expect(body1.magicImportQuery).toMatch(/^\?magic=/);

        // 2. 第二次寫入：使用 X-API-Key 追加單筆活動 (預設 mode=merge)
        const req2 = new Request('https://worker.example.com/api/v1/ingest?channel=tokyo2026', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': 'my-super-secret-token-2026',
            },
            body: JSON.stringify({
                activity: {
                    id: 'act-1',
                    title: '皇居外苑晨跑 5K',
                    startDate: '2026-12-24',
                    time: '07:00',
                },
            }),
        });

        const res2 = await worker.fetch(req2, env);
        expect(res2.status).toBe(200);
        const body2 = await res2.json();
        expect(body2.revision).toBe(2);
        expect(body2.summary.tickets).toBe(1);
        expect(body2.summary.hotels).toBe(1);
        expect(body2.summary.activities).toBe(1);

        // 3. 讀取通道 (sinceRevision=1 應回傳 hasUpdate: true 與完整 payload)
        const reqGetUpdate = new Request(
            'https://worker.example.com/api/v1/ingest?channel=tokyo2026&sinceRevision=1',
            {
                method: 'GET',
                headers: { 'Authorization': 'Bearer my-super-secret-token-2026' },
            }
        );
        const resGetUpdate = await worker.fetch(reqGetUpdate, env);
        const getUpdateBody = await resGetUpdate.json();
        expect(getUpdateBody.hasUpdate).toBe(true);
        expect(getUpdateBody.revision).toBe(2);
        expect(getUpdateBody.data.tickets).toHaveLength(1);
        expect(getUpdateBody.data.hotels).toHaveLength(1);
        expect(getUpdateBody.data.activities).toHaveLength(1);

        // 4. 讀取通道 (sinceRevision=2 已是最新，應回傳 hasUpdate: false)
        const reqGetNoUpdate = new Request(
            'https://worker.example.com/api/v1/ingest?channel=tokyo2026&sinceRevision=2',
            {
                method: 'GET',
                headers: { 'Authorization': 'Bearer my-super-secret-token-2026' },
            }
        );
        const resGetNoUpdate = await worker.fetch(reqGetNoUpdate, env);
        const getNoUpdateBody = await resGetNoUpdate.json();
        expect(getNoUpdateBody.hasUpdate).toBe(false);
        expect(getNoUpdateBody.revision).toBe(2);
    });

    it('前端 ingestApiService 儲存設定、版本記憶與 pull/push 流程正常運作', async () => {
        saveApiSyncConfig({
            endpointUrl: 'https://worker.example.com/',
            apiToken: 'my-super-secret-token-2026',
            channel: 'tokyo2026',
            autoPullOnLoad: true,
            importMode: 'replace',
        });

        const cfg = getStoredApiSyncConfig();
        expect(cfg.endpointUrl).toBe('https://worker.example.com');
        expect(cfg.apiToken).toBe('my-super-secret-token-2026');
        expect(cfg.channel).toBe('tokyo2026');

        setLastSyncedRevision('tokyo2026', 3);
        expect(getLastSyncedRevision('tokyo2026')).toBe(3);

        const curlText = buildIngestCurlExamples(cfg);
        expect(curlText).toContain('https://worker.example.com/api/v1/ingest?channel=tokyo2026');
        expect(curlText).toContain('Authorization: Bearer my-super-secret-token-2026');

        // 透過 stub fetch 串接真實 worker.fetch
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn((url, init) => worker.fetch(new Request(url, init), env));
        try {
            const pushRes = await pushToIngestApi({
                endpointUrl: cfg.endpointUrl,
                apiToken: cfg.apiToken,
                channel: cfg.channel,
                mode: 'replace',
                payload: {
                    trip: { title: '2026 Tokyo 聖誕跨年', startDate: '2026-12-23', endDate: '2027-01-03' },
                    hotels: [{ id: 'h1', name: '東橫INN 東京日本橋馬喰町', checkIn: '2026-12-23', checkOut: '2026-12-24' }],
                },
            });
            expect(pushRes.success).toBe(true);
            expect(pushRes.revision).toBe(1);

            const pullRes = await pullFromIngestApi({
                endpointUrl: cfg.endpointUrl,
                apiToken: cfg.apiToken,
                channel: cfg.channel,
                sinceRevision: 0,
            });
            expect(pullRes.hasUpdate).toBe(true);
            expect(pullRes.data.trip.title).toBe('2026 Tokyo 聖誕跨年');
            expect(pullRes.data.hotels).toHaveLength(1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
