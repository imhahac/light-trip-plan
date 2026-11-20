import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    getDB,
    STORES,
    tripRepo,
    dayPlanRepo,
    placeItemRepo,
    reservationRepo,
    expenseRepo,
    packingRepo,
    todoRepo,
} from '../../db';
import {
    parseUnifiedJsonInput,
    executeUnifiedJsonImport,
    buildFullJsonExport,
    getJsonImportTemplate,
} from '../jsonTripImportService';

describe('jsonTripImportService - 一次性 JSON 匯入／匯出', () => {
    beforeEach(async () => {
        const db = await getDB();
        const allStores = Object.values(STORES);
        const tx = db.transaction(allStores, 'readwrite');
        for (const store of allStores) {
            await tx.objectStore(store).clear();
        }
        await tx.done;
    });

    it('支援解析 Markdown ```json 圍欄並一次性匯入完整旅程 + 票券至當前旅程', async () => {
        const activeTrip = {
            id: 'trip_tokyo_2026',
            title: '2026 Tokyo 聖誕跨年',
            startDate: '2026-12-24',
            endDate: '2026-12-28',
            baseCurrency: 'TWD',
        };
        await tripRepo.save(activeTrip);

        const template = getJsonImportTemplate(activeTrip);
        const fenced = '```json\n' + JSON.stringify(template, null, 2) + '\n```';

        const parsed = parseUnifiedJsonInput(fenced, { activeTrip });
        expect(parsed.summary.daysCount).toBe(2);
        expect(parsed.summary.placesCount).toBe(4);
        expect(parsed.summary.ticketsCount).toBe(1);
        expect(parsed.summary.hotelsCount).toBe(1);
        expect(parsed.summary.activitiesCount).toBe(1);
        expect(parsed.summary.expensesCount).toBe(1);
        expect(parsed.summary.packingCount).toBe(2);
        expect(parsed.summary.todosCount).toBe(1);

        let ticketsState = [];
        let hotelsState = [];
        let activitiesState = [];

        const result = await executeUnifiedJsonImport({
            parsed,
            activeTrip,
            mode: 'merge',
            tripTarget: 'current',
            dataSetters: {
                setTickets: (updater) => { ticketsState = updater(ticketsState); },
                setHotels: (updater) => { hotelsState = updater(hotelsState); },
                setActivities: (updater) => { activitiesState = updater(activitiesState); },
            },
        });

        expect(result.targetTripId).toBe('trip_tokyo_2026');

        const savedPlaces = await placeItemRepo.getByTrip('trip_tokyo_2026');
        expect(savedPlaces).toHaveLength(4);
        expect(savedPlaces.filter((p) => p.dayIndex === 0)).toHaveLength(2);
        expect(savedPlaces.filter((p) => p.dayIndex === 1)).toHaveLength(2);

        const savedPlans = await dayPlanRepo.getByTrip('trip_tokyo_2026');
        expect(savedPlans).toHaveLength(2);
        expect(savedPlans.find((d) => d.dayIndex === 0)?.theme).toBe('抵達與市區散步');

        expect(await expenseRepo.getByTrip('trip_tokyo_2026')).toHaveLength(1);
        expect(await packingRepo.getByTrip('trip_tokyo_2026')).toHaveLength(2);
        expect(await todoRepo.getByTrip('trip_tokyo_2026')).toHaveLength(1);
        expect(ticketsState).toHaveLength(1);
        expect(hotelsState).toHaveLength(1);
        expect(activitiesState).toHaveLength(1);
    });

    it('支援扁平 places 陣列以 date 自動推算 dayIndex，並可建立為全新旅程', async () => {
        const raw = JSON.stringify({
            trip: {
                title: '2026 京都跨年',
                startDate: '2026-12-30',
                endDate: '2027-01-02',
                baseCurrency: 'TWD',
            },
            places: [
                { name: '伏見稻荷大社', date: '2026-12-30', lat: 34.9671, lng: 135.7727 },
                { name: '清水寺', date: '2027-01-01', lat: 34.9949, lng: 135.785 },
            ],
            reservations: [
                { type: 'restaurant', title: '菊乃井本店', confirmationCode: 'KK999', startDate: '2026-12-31' },
            ],
        });

        const parsed = parseUnifiedJsonInput(raw);
        const { targetTripId } = await executeUnifiedJsonImport({
            parsed,
            activeTrip: null,
            mode: 'merge',
            tripTarget: 'new',
        });

        const trip = await tripRepo.get(targetTripId);
        expect(trip.title).toBe('2026 京都跨年');

        const places = await placeItemRepo.getByTrip(targetTripId);
        expect(places.find((p) => p.name === '伏見稻荷大社')?.dayIndex).toBe(0);
        expect(places.find((p) => p.name === '清水寺')?.dayIndex).toBe(2);

        const res = await reservationRepo.getByTrip(targetTripId);
        expect(res).toHaveLength(1);
        expect(res[0].confirmationCode).toBe('KK999');
    });

    it('支援舊版純 tickets 陣列與完整匯出再匯入 Round-Trip', async () => {
        const legacyOnly = parseUnifiedJsonInput(JSON.stringify([
            {
                id: 'legacy-1',
                type: 'normal',
                airline: '華航',
                departRegion: 'TPE',
                returnRegion: 'NRT',
                outboundDate: '2026-06-01',
                price: 12000,
            },
        ]));
        expect(legacyOnly.summary.ticketsCount).toBe(1);
        expect(legacyOnly.normalized.tickets[0].priceTWD).toBe(12000);

        const exported = buildFullJsonExport({
            trip: { id: 't1', title: 'RoundTrip', startDate: '2026-07-01', endDate: '2026-07-02', baseCurrency: 'TWD' },
            places: [{ id: 'p1', dayIndex: 0, name: '台北 101', lat: 25.0339, lng: 121.5644, orderIndex: 0 }],
            tickets: legacyOnly.normalized.tickets,
            hotels: [],
            activities: [],
        });

        const reparsed = parseUnifiedJsonInput(JSON.stringify(exported));
        expect(reparsed.summary.tripTitle).toBe('RoundTrip');
        expect(reparsed.summary.placesCount).toBe(1);
        expect(reparsed.summary.ticketsCount).toBe(1);
    });

    it('無效 JSON 或無法識別結構時拋出清楚錯誤訊息', () => {
        expect(() => parseUnifiedJsonInput('')).toThrow(/為空/);
        expect(() => parseUnifiedJsonInput('{ invalid')).toThrow(/語法解析失敗/);
        expect(() => parseUnifiedJsonInput('{"foo": "bar"}')).toThrow(/無法識別的 JSON 結構/);
    });
});
