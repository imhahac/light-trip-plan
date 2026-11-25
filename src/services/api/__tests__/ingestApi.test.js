import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../../../../cloudflare-worker/worker';
import {
    getStoredApiSyncConfig,
    saveApiSyncConfig,
    getLastSyncedRevision,
    setLastSyncedRevision,
    pullFromIngestApi,
    pushToIngestApi,
    listSubKeys,
    createSubKey,
    revokeSubKey,
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
        list: vi.fn(async ({ prefix = '' } = {}) => ({
            keys: [...store.keys()]
                .filter((k) => k.startsWith(prefix))
                .sort()
                .map((name) => ({ name })),
            list_complete: true,
        })),
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
        expect(body1.magicImportQuery).toBeUndefined();

        // 2. 第二次寫入：使用 X-API-Key 追加單筆活動 (預設 mode=merge)，並顯式要求 createSnapshot=true
        const req2 = new Request('https://worker.example.com/api/v1/ingest?channel=tokyo2026&createSnapshot=true', {
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
        expect(body2.magicImportQuery).toMatch(/^\?magic=/);

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

    it('支援多組逗號分隔 Master Token 以及 /api/v1/keys 子金鑰簽發、限權 (通道/讀寫) 與立即撤銷', async () => {
        env.API_SECRET_TOKEN = 'master-key-1, master-key-2';

        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn((url, init) => worker.fetch(new Request(url, init), env));
        try {
            // 1. 使用第二組 Master Token 簽發一組僅限 tokyo2026 通道的「讀寫」子金鑰
            const issued = await createSubKey({
                endpointUrl: 'https://worker.example.com',
                apiToken: 'master-key-2',
                label: '旅伴小明',
                permissions: ['read', 'write'],
                allowedChannels: ['tokyo2026'],
                expiresInDays: 30,
            });
            expect(issued.id).toMatch(/^key_/);
            expect(issued.token).toMatch(/^ltp_sk_/);
            expect(issued.tokenMask).toContain('ltp_sk_');

            // 2. 簽發另一組「唯讀」子金鑰
            const readOnlyKey = await createSubKey({
                endpointUrl: 'https://worker.example.com',
                apiToken: 'master-key-1',
                label: '唯讀檢視器',
                permissions: ['read'],
                allowedChannels: ['tokyo2026'],
            });

            // 3. 查詢子金鑰清單 (不應暴露明文 token 或 tokenHash)
            const keysList = await listSubKeys({
                endpointUrl: 'https://worker.example.com',
                apiToken: 'master-key-1',
            });
            expect(keysList).toHaveLength(2);
            expect(keysList[0].token).toBeUndefined();
            expect(keysList[0].tokenHash).toBeUndefined();

            // 4. 子金鑰本身不可呼叫 /api/v1/keys 管理其他金鑰 (應回傳 403)
            await expect(
                listSubKeys({
                    endpointUrl: 'https://worker.example.com',
                    apiToken: issued.token,
                })
            ).rejects.toThrow(/403|僅限 Master/);

            // 5. 使用「旅伴小明」子金鑰寫入授權的 tokyo2026 通道 -> 成功
            const writeOk = await pushToIngestApi({
                endpointUrl: 'https://worker.example.com',
                apiToken: issued.token,
                channel: 'tokyo2026',
                mode: 'merge',
                payload: {
                    activity: { id: 'act-sub-1', title: '晴空塔夜景', startDate: '2026-12-24' },
                },
            });
            expect(writeOk.success).toBe(true);

            // 6. 使用「旅伴小明」子金鑰嘗試寫入未授權的 osaka2026 通道 -> 403 Forbidden
            await expect(
                pushToIngestApi({
                    endpointUrl: 'https://worker.example.com',
                    apiToken: issued.token,
                    channel: 'osaka2026',
                    mode: 'merge',
                    payload: { activity: { id: 'act-x', title: '道頓堀' } },
                })
            ).rejects.toThrow(/403|未獲授權存取通道/);

            // 7. 使用「唯讀」子金鑰讀取 tokyo2026 -> 成功；嘗試寫入 -> 403 Forbidden
            const readOk = await pullFromIngestApi({
                endpointUrl: 'https://worker.example.com',
                apiToken: readOnlyKey.token,
                channel: 'tokyo2026',
            });
            expect(readOk.data.activities).toHaveLength(1);

            await expect(
                pushToIngestApi({
                    endpointUrl: 'https://worker.example.com',
                    apiToken: readOnlyKey.token,
                    channel: 'tokyo2026',
                    payload: { activity: { id: 'act-fail', title: 'Fail' } },
                })
            ).rejects.toThrow(/403|缺少 "write" 權限/);

            // 8. Master Token 撤銷「旅伴小明」子金鑰後，該子金鑰立即失效 (401)
            const revRes = await revokeSubKey({
                endpointUrl: 'https://worker.example.com',
                apiToken: 'master-key-1',
                keyId: issued.id,
            });
            expect(revRes.revokedId).toBe(issued.id);

            await expect(
                pullFromIngestApi({
                    endpointUrl: 'https://worker.example.com',
                    apiToken: issued.token,
                    channel: 'tokyo2026',
                })
            ).rejects.toThrow(/401|無效或已撤銷/);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('Append-Only Inbox 併發寫入 (Promise.all) 不會發生 Lost Update', async () => {
        const reqA = new Request('https://worker.example.com/api/v1/ingest?channel=concurrent', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer my-super-secret-token-2026',
            },
            body: JSON.stringify({ activity: { id: 'act-a', title: '併發活動 A', startDate: '2026-12-24' } }),
        });
        const reqB = new Request('https://worker.example.com/api/v1/ingest?channel=concurrent', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer my-super-secret-token-2026',
            },
            body: JSON.stringify({ activity: { id: 'act-b', title: '併發活動 B', startDate: '2026-12-25' } }),
        });

        const [resA, resB] = await Promise.all([worker.fetch(reqA, env), worker.fetch(reqB, env)]);
        expect(resA.status).toBe(200);
        expect(resB.status).toBe(200);

        const resGet = await worker.fetch(
            new Request('https://worker.example.com/api/v1/ingest?channel=concurrent&sinceRevision=0', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer my-super-secret-token-2026' },
            }),
            env
        );
        const body = await resGet.json();
        expect(body.revision).toBe(2);
        const ids = body.data.activities.map((a) => a.id).sort();
        expect(ids).toEqual(['act-a', 'act-b']);
    });

    it('CORS 白名單 (ALLOWED_ORIGINS) 應拒絕未授權 Origin 並放行合法 Origin', async () => {
        const evilReq = new Request('https://worker.example.com/api/v1/ingest?channel=default', {
            method: 'OPTIONS',
            headers: { Origin: 'https://evil.example.com' },
        });
        const evilRes = await worker.fetch(evilReq, env);
        expect(evilRes.headers.get('Access-Control-Allow-Origin')).toBe('null');

        const okReq = new Request('https://worker.example.com/api/v1/ingest?channel=default', {
            method: 'OPTIONS',
            headers: { Origin: 'https://imhahac.github.io' },
        });
        const okRes = await worker.fetch(okReq, env);
        expect(okRes.headers.get('Access-Control-Allow-Origin')).toBe('https://imhahac.github.io');
    });

    it('?api=unshorten 遇到 302 轉址至內網/Metadata IP 時應回傳 403 SSRF 防護', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => new Response(null, {
            status: 302,
            headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
        }));
        try {
            const req = new Request(
                'https://worker.example.com/?api=unshorten&url=' + encodeURIComponent('https://maps.app.goo.gl/fake'),
                { method: 'GET' }
            );
            const res = await worker.fetch(req, env);
            expect(res.status).toBe(403);
            const data = await res.json();
            expect(data.error).toMatch(/禁止存取|內網|Metadata|私有/i);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
