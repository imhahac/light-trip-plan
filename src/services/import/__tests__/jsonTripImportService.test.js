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

    it('支援無頂層 trip/days 欄位之完整 2026-2027 東京跨年 12 日 JSON 自動推導旅程並同步轉入每日排程景點', async () => {
        const winterTokyoJson = JSON.stringify({
            tickets: [
                {
                    id: 'ticket-2026-tsa-hnd-winter',
                    type: 'normal',
                    airline: '中華航空',
                    departRegion: 'TSA (台北松山)',
                    returnRegion: 'HND (東京羽田)',
                    outboundDate: '2026-12-23',
                    outboundTime: '18:25',
                    outboundArrivalDate: '2026-12-23',
                    outboundArrivalTime: '22:15',
                    outboundFlightNo: 'CI222',
                    inboundDate: '2027-01-03',
                    inboundTime: '14:15',
                    inboundArrivalDate: '2027-01-03',
                    inboundArrivalTime: '17:15',
                    inboundFlightNo: 'CI221',
                    currency: 'TWD',
                    exchangeRate: 1,
                    price: 0,
                    priceTWD: 0,
                    isPaid: true
                }
            ],
            hotels: [
                {
                    id: 'hotel-2026-toyoko-bakurocho',
                    name: '東橫INN 東京日本橋馬喰町',
                    address: '東京都中央區日本橋大伝馬町14-16',
                    checkIn: '2026-12-23',
                    checkOut: '2027-01-03',
                    currency: 'JPY',
                    priceTotal: 107800,
                    priceTWD: 23716,
                    confirmationNo: '',
                    notes: '含免費早餐',
                    isPaid: false,
                    lat: 35.6923,
                    lng: 139.7825
                }
            ],
            activities: [
                {
                    id: 'act-2026-1223-01',
                    title: '羽田T3→東日本橋直通電車',
                    category: 'transport',
                    startDate: '2026-12-23',
                    endDate: '',
                    time: '23:18',
                    location: '羽田機場第3航廈 → 東日本橋站',
                    currency: 'JPY',
                    exchangeRate: 0.22,
                    price: 560,
                    priceTWD: 123,
                    notes: '京急空港線直通都營淺草線',
                    isPaid: false,
                    lat: 35.5446,
                    lng: 139.7681
                },
                {
                    id: 'act-2027-0103-01',
                    title: '東日本橋→羽田機場T3直通電車',
                    category: 'transport',
                    startDate: '2027-01-03',
                    endDate: '',
                    time: '10:40',
                    location: '東日本橋站 → 羽田機場第3航廈',
                    currency: 'JPY',
                    exchangeRate: 0.22,
                    price: 560,
                    priceTWD: 123,
                    notes: '10:00東橫INN退房',
                    isPaid: false,
                    lat: 35.5446,
                    lng: 139.7681
                }
            ],
            tripLabels: {
                'ticket-2026-tsa-hnd-winter-1': '2026–2027 東京冬季跨年 12 日（含聖誕點燈・滑雪・箱根驛傳）'
            },
            tripBudgets: {
                'ticket-2026-tsa-hnd-winter-1': 62000
            },
            tripOverrides: {
                version: 1,
                segTripId: {},
                removedSegIds: [],
                tripOrder: []
            }
        });

        const parsed = parseUnifiedJsonInput(winterTokyoJson);
        expect(parsed.summary.hasTripMeta).toBe(true);
        expect(parsed.summary.tripTitle).toBe('2026–2027 東京冬季跨年 12 日（含聖誕點燈・滑雪・箱根驛傳）');
        expect(parsed.normalized.trip.startDate).toBe('2026-12-23');
        expect(parsed.normalized.trip.endDate).toBe('2027-01-03');
        expect(parsed.normalized.trip.budget).toBe(62000);
        expect(parsed.summary.ticketsCount).toBe(1);
        expect(parsed.summary.hotelsCount).toBe(1);
        expect(parsed.summary.activitiesCount).toBe(2);
        expect(parsed.summary.placesCount).toBe(2);

        const { targetTripId } = await executeUnifiedJsonImport({
            parsed,
            activeTrip: null,
            mode: 'merge',
            tripTarget: 'new',
        });

        const savedTrip = await tripRepo.get(targetTripId);
        expect(savedTrip.title).toBe('2026–2027 東京冬季跨年 12 日（含聖誕點燈・滑雪・箱根驛傳）');
        expect(savedTrip.startDate).toBe('2026-12-23');
        expect(savedTrip.endDate).toBe('2027-01-03');
        expect(savedTrip.budget).toBe(62000);

        const savedPlaces = await placeItemRepo.getByTrip(targetTripId);
        expect(savedPlaces).toHaveLength(2);
        expect(savedPlaces.find(p => p.activityId === 'act-2026-1223-01')?.dayIndex).toBe(0);
        expect(savedPlaces.find(p => p.activityId === 'act-2027-0103-01')?.dayIndex).toBe(11);
    });
});
