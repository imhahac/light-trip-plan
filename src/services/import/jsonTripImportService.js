/**
 * jsonTripImportService.js
 * 統一一次性 JSON 匯入／匯出服務：
 * - 支援純機票陣列、舊版 reverse-tickets.json（tickets / hotels / activities / tripLabels / tripBudgets / tripOverrides）
 * - 支援完整 TREK 旅程 JSON（trip / days / dayPlans / places / reservations / expenses / packingItems / todos）
 * - 支援上述兩者合併為單一 JSON 一次性匯入，並支援合併 (merge) 或覆寫 (replace) 模式
 */

import {
    tripRepo,
    dayPlanRepo,
    placeItemRepo,
    reservationRepo,
    expenseRepo,
    packingRepo,
    todoRepo,
} from '../db';
import { assembleTripDays } from '../trips/tripExportAssembler';

const makeId = (prefix, idx = 0) =>
    `${prefix}_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;

/**
 * 去除可能由 AI 對話複製而來的 Markdown ```json ... ``` 圍欄
 */
function stripCodeFences(rawText) {
    const trimmed = String(rawText || '').trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function toFiniteNumber(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
}

function toDateOnly(val) {
    if (!val || typeof val !== 'string') return '';
    return val.trim().slice(0, 10);
}

function calcDayDiff(baseDateStr, targetDateStr) {
    const base = toDateOnly(baseDateStr);
    const target = toDateOnly(targetDateStr);
    if (!base || !target) return null;
    const d1 = new Date(`${base}T00:00:00Z`);
    const d2 = new Date(`${target}T00:00:00Z`);
    if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return null;
    return Math.round((d2 - d1) / 86400000);
}

function resolveDayIndex(item, tripStartDate, fallbackIdx = 0) {
    if (Number.isInteger(item?.dayIndex) && item.dayIndex >= 0) {
        return item.dayIndex;
    }
    if (item?.dayIndex !== undefined && item?.dayIndex !== null && item?.dayIndex !== '') {
        const parsed = Number(item.dayIndex);
        if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
    const oneBased = item?.day ?? item?.dayNumber;
    if (oneBased !== undefined && oneBased !== null && oneBased !== '') {
        const parsed = Number(oneBased);
        if (Number.isInteger(parsed) && parsed >= 1) return parsed - 1;
    }
    if (item?.date && tripStartDate) {
        const diff = calcDayDiff(tripStartDate, item.date);
        if (diff !== null && diff >= 0) return diff;
    }
    return fallbackIdx;
}

function normalizeTicket(raw, idx) {
    if (!raw || typeof raw !== 'object') return null;
    const price = Number(raw.price ?? raw.priceTotal ?? 0) || 0;
    const exchangeRate = Number(raw.exchangeRate) > 0 ? Number(raw.exchangeRate) : 1;
    const priceTWD = raw.priceTWD !== undefined && raw.priceTWD !== null
        ? Number(raw.priceTWD) || 0
        : Math.round(price * exchangeRate);

    return {
        ...raw,
        id: String(raw.id || makeId('ticket', idx)),
        type: ['normal', 'reverse', 'oneway'].includes(raw.type) ? raw.type : 'normal',
        airline: raw.airline || '',
        currency: raw.currency || 'TWD',
        exchangeRate,
        price,
        priceTWD,
        departRegion: raw.departRegion || raw.from || '',
        returnRegion: raw.returnRegion || raw.to || '',
        outboundDate: toDateOnly(raw.outboundDate || raw.date || ''),
        outboundTime: raw.outboundTime || '',
        outboundArrivalDate: toDateOnly(raw.outboundArrivalDate || raw.outboundDate || ''),
        outboundArrivalTime: raw.outboundArrivalTime || '',
        outboundFlightNo: String(raw.outboundFlightNo || raw.flightNo || '').toUpperCase(),
        inboundDate: toDateOnly(raw.inboundDate || ''),
        inboundTime: raw.inboundTime || '',
        inboundArrivalDate: toDateOnly(raw.inboundArrivalDate || raw.inboundDate || ''),
        inboundArrivalTime: raw.inboundArrivalTime || '',
        inboundFlightNo: String(raw.inboundFlightNo || '').toUpperCase(),
        isPaid: Boolean(raw.isPaid),
    };
}

function normalizeHotel(raw, idx) {
    if (!raw || typeof raw !== 'object') return null;
    const priceTotal = Number(raw.priceTotal ?? raw.price ?? 0) || 0;
    const exchangeRate = Number(raw.exchangeRate) > 0 ? Number(raw.exchangeRate) : 1;
    const priceTWD = raw.priceTWD !== undefined && raw.priceTWD !== null
        ? Number(raw.priceTWD) || 0
        : Math.round(priceTotal * exchangeRate);
    const lat = toFiniteNumber(raw.lat);
    const lng = toFiniteNumber(raw.lng);

    return {
        ...raw,
        id: String(raw.id || makeId('hotel', idx)),
        name: raw.name || raw.title || '未命名飯店',
        address: raw.address || '',
        checkIn: toDateOnly(raw.checkIn || raw.checkInDate || ''),
        checkOut: toDateOnly(raw.checkOut || raw.checkOutDate || ''),
        currency: raw.currency || 'TWD',
        priceTotal,
        priceTWD,
        confirmationNo: raw.confirmationNo || raw.confirmationCode || '',
        notes: raw.notes || '',
        isPaid: Boolean(raw.isPaid),
        ...(lat !== null ? { lat } : {}),
        ...(lng !== null ? { lng } : {}),
    };
}

function normalizeActivity(raw, idx) {
    if (!raw || typeof raw !== 'object') return null;
    const price = Number(raw.price ?? raw.cost ?? 0) || 0;
    const exchangeRate = Number(raw.exchangeRate) > 0 ? Number(raw.exchangeRate) : 1;
    const priceTWD = raw.priceTWD !== undefined && raw.priceTWD !== null
        ? Number(raw.priceTWD) || 0
        : Math.round(price * exchangeRate);
    const lat = toFiniteNumber(raw.lat);
    const lng = toFiniteNumber(raw.lng);

    return {
        ...raw,
        id: String(raw.id || makeId('activity', idx)),
        title: raw.title || raw.name || '未命名活動',
        category: raw.category || 'attraction',
        startDate: toDateOnly(raw.startDate || raw.date || ''),
        endDate: toDateOnly(raw.endDate || ''),
        time: raw.time || '',
        location: raw.location || raw.address || '',
        currency: raw.currency || 'TWD',
        exchangeRate,
        price,
        priceTWD,
        notes: raw.notes || '',
        isPaid: Boolean(raw.isPaid),
        ...(lat !== null ? { lat } : {}),
        ...(lng !== null ? { lng } : {}),
    };
}

function normalizePlace(raw, dayIndex, orderIndex, idx) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || raw.title || '').trim();
    if (!name) return null;
    const lat = toFiniteNumber(raw.lat ?? raw.latitude);
    const lng = toFiniteNumber(raw.lng ?? raw.lon ?? raw.longitude);

    return {
        ...raw,
        id: String(raw.id || makeId('place', idx)),
        dayIndex,
        name,
        lat,
        lng,
        address: raw.address || raw.location || '',
        notes: raw.notes || raw.desc || raw.description || '',
        time: raw.time || raw.startTime || '',
        category: raw.category || '',
        isLocked: Boolean(raw.isLocked),
        orderIndex: Number.isInteger(raw.orderIndex) ? raw.orderIndex : orderIndex,
        createdAt: raw.createdAt || Date.now(),
    };
}

function normalizeReservation(raw, idx, defaultCurrency = 'TWD') {
    if (!raw || typeof raw !== 'object') return null;
    return {
        ...raw,
        id: String(raw.id || makeId('res', idx)),
        type: raw.type || 'other',
        status: raw.status || 'confirmed',
        title: raw.title || raw.name || '預訂項目',
        confirmationCode: raw.confirmationCode || raw.confirmationNo || '',
        cost: Number(raw.cost ?? raw.price ?? 0) || 0,
        currency: raw.currency || defaultCurrency,
        startDate: raw.startDate || '',
        endDate: raw.endDate || '',
        notes: raw.notes || '',
        travellers: Array.isArray(raw.travellers) ? raw.travellers : [],
        createdAt: raw.createdAt || Date.now(),
        updatedAt: Date.now(),
    };
}

function normalizeExpense(raw, idx, defaultCurrency = 'TWD') {
    if (!raw || typeof raw !== 'object') return null;
    const amount = Number(raw.amount ?? raw.price ?? 0) || 0;
    const rateToTripBase = Number(raw.rateToTripBase ?? raw.exchangeRate) > 0
        ? Number(raw.rateToTripBase ?? raw.exchangeRate)
        : 1;
    const baseAmount = raw.baseAmount !== undefined && raw.baseAmount !== null
        ? Number(raw.baseAmount) || 0
        : Math.round(amount * rateToTripBase);
    const paidBy = raw.paidBy || '我';
    const participants = Array.isArray(raw.participants) && raw.participants.length > 0
        ? raw.participants
        : [paidBy];
    const shares = raw.shares && typeof raw.shares === 'object'
        ? raw.shares
        : participants.reduce((acc, member) => {
            acc[member] = Math.round((baseAmount / participants.length) * 100) / 100;
            return acc;
        }, {});

    return {
        ...raw,
        id: String(raw.id || makeId('exp', idx)),
        title: raw.title || raw.name || '未命名支出',
        category: raw.category || 'other',
        amount,
        currency: raw.currency || defaultCurrency,
        rateToTripBase,
        baseCurrency: raw.baseCurrency || defaultCurrency,
        baseAmount,
        date: toDateOnly(raw.date || ''),
        paidBy,
        participants,
        shares,
        splitType: raw.splitType || 'equal',
        settled: Boolean(raw.settled),
        createdAt: raw.createdAt || Date.now(),
    };
}

function normalizePackingItem(raw, idx) {
    if (!raw || typeof raw !== 'object') return null;
    const itemName = String(raw.itemName || raw.name || raw.title || '').trim();
    if (!itemName) return null;
    return {
        ...raw,
        id: String(raw.id || makeId('pack', idx)),
        category: raw.category || 'essential',
        itemName,
        notes: raw.notes || '',
        isPacked: Boolean(raw.isPacked ?? raw.packed),
        assignee: raw.assignee || '全體',
        visibilityTier: raw.visibilityTier || 'all',
        weightGrams: Number(raw.weightGrams ?? raw.weight ?? 0) || 0,
        createdAt: raw.createdAt || Date.now(),
    };
}

function normalizeTodo(raw, idx) {
    if (!raw || typeof raw !== 'object') return null;
    const title = String(raw.title || raw.name || '').trim();
    if (!title) return null;
    return {
        ...raw,
        id: String(raw.id || makeId('todo', idx)),
        title,
        priority: ['high', 'medium', 'low'].includes(raw.priority) ? raw.priority : 'medium',
        dueDate: toDateOnly(raw.dueDate || ''),
        assignee: raw.assignee || '我',
        completed: Boolean(raw.completed ?? raw.done),
        createdAt: raw.createdAt || Date.now(),
    };
}

/**
 * 解析並標準化使用者上傳或貼上的 JSON 字串
 * @param {string} rawText
 * @param {{ activeTrip?: Object }} [options]
 */
export function parseUnifiedJsonInput(rawText, options = {}) {
    const cleaned = stripCodeFences(rawText);
    if (!cleaned) {
        throw new Error('JSON 內容為空，請上傳檔案或貼上 JSON 文字');
    }

    let data;
    try {
        data = JSON.parse(cleaned);
    } catch (err) {
        throw new Error(`JSON 語法解析失敗：${err.message}`);
    }

    if (!data || typeof data !== 'object') {
        throw new Error('JSON 根節點必須為物件 ({ ... }) 或機票陣列 ([ ... ])');
    }

    // 向下相容：純機票陣列
    if (Array.isArray(data)) {
        const tickets = data.map(normalizeTicket).filter(Boolean);
        if (tickets.length === 0) {
            throw new Error('陣列中未找到有效的機票資料');
        }
        return {
            normalized: {
                trip: null,
                dayPlans: [],
                places: [],
                reservations: [],
                expenses: [],
                packingItems: [],
                todos: [],
                tickets,
                hotels: null,
                activities: null,
                tripLabels: null,
                tripBudgets: null,
                tripOverrides: null,
            },
            summary: {
                hasTripMeta: false,
                tripTitle: '',
                daysCount: 0,
                placesCount: 0,
                reservationsCount: 0,
                expensesCount: 0,
                packingCount: 0,
                todosCount: 0,
                ticketsCount: tickets.length,
                hotelsCount: 0,
                activitiesCount: 0,
                hasTripScopedData: false,
                hasGlobalBookingData: true,
                totalItems: tickets.length,
            },
        };
    }

    const hasTicketsKey = Array.isArray(data.tickets);
    const hasHotelsKey = Array.isArray(data.hotels);
    const hasActivitiesKey = Array.isArray(data.activities);
    const hasLabelsKey = data.tripLabels && typeof data.tripLabels === 'object' && !Array.isArray(data.tripLabels);
    const hasBudgetsKey = data.tripBudgets && typeof data.tripBudgets === 'object' && !Array.isArray(data.tripBudgets);
    const hasOverridesKey = data.tripOverrides && typeof data.tripOverrides === 'object' && !Array.isArray(data.tripOverrides);

    const tickets = hasTicketsKey ? data.tickets.map(normalizeTicket).filter(Boolean) : null;
    const hotels = hasHotelsKey ? data.hotels.map(normalizeHotel).filter(Boolean) : null;
    const activities = hasActivitiesKey ? data.activities.map(normalizeActivity).filter(Boolean) : null;
    const tripLabels = hasLabelsKey ? data.tripLabels : null;
    const tripBudgets = hasBudgetsKey ? data.tripBudgets : null;
    const tripOverrides = hasOverridesKey ? data.tripOverrides : null;

    const activeStartDate = options.activeTrip?.startDate || '';

    // 若 JSON 未明確提供頂層 trip 物件，自動從 tripLabels / tripBudgets / tickets / hotels / activities 推導旅程 메타資訊
    const inferredTripMeta = (() => {
        if (data.trip && typeof data.trip === 'object') return null;

        const allDates = [];
        (tickets || []).forEach((t) => {
            if (t.outboundDate) allDates.push(t.outboundDate);
            if (t.outboundArrivalDate) allDates.push(t.outboundArrivalDate);
            if (t.inboundDate) allDates.push(t.inboundDate);
            if (t.inboundArrivalDate) allDates.push(t.inboundArrivalDate);
        });
        (hotels || []).forEach((h) => {
            if (h.checkIn) allDates.push(h.checkIn);
            if (h.checkOut) allDates.push(h.checkOut);
        });
        (activities || []).forEach((a) => {
            if (a.startDate) allDates.push(a.startDate);
            if (a.endDate) allDates.push(a.endDate);
        });
        const validDates = allDates.filter(Boolean).sort();

        const labelValues = tripLabels
            ? Object.values(tripLabels).map((v) => String(v || '').trim()).filter(Boolean)
            : [];
        const budgetValues = tripBudgets
            ? Object.values(tripBudgets).map((v) => Number(v) || 0).filter((v) => v > 0)
            : [];

        if (validDates.length === 0 && labelValues.length === 0 && budgetValues.length === 0) {
            return null;
        }

        let fallbackTitle = labelValues[0] || '';
        if (!fallbackTitle && tickets && tickets.length > 0) {
            const firstT = tickets[0];
            const fromCode = (firstT.departRegion || '').split(' ')[0];
            const toCode = (firstT.returnRegion || '').split(' ')[0];
            if (fromCode && toCode) {
                fallbackTitle = `${fromCode} → ${toCode} 旅程`;
            }
        }

        return {
            title: fallbackTitle,
            startDate: validDates[0] || activeStartDate,
            endDate: validDates[validDates.length - 1] || validDates[0] || options.activeTrip?.endDate || activeStartDate,
            baseCurrency: options.activeTrip?.baseCurrency || 'TWD',
            budget: budgetValues[0] || 0,
            destination: options.activeTrip?.destination || '',
            status: 'planning',
            isInferred: true,
        };
    })();

    const tripMeta = data.trip && typeof data.trip === 'object'
        ? {
            title: String(data.trip.title || '').trim(),
            startDate: toDateOnly(data.trip.startDate || ''),
            endDate: toDateOnly(data.trip.endDate || ''),
            baseCurrency: data.trip.baseCurrency || 'TWD',
            budget: Number(data.trip.budget) || 0,
            destination: data.trip.destination || '',
            status: data.trip.status || 'planning',
        }
        : inferredTripMeta;

    const baseStartDate = tripMeta?.startDate || activeStartDate;
    const baseCurrency = tripMeta?.baseCurrency || options.activeTrip?.baseCurrency || 'TWD';

    // 解析 days / dayPlans / places
    const dayPlansMap = new Map();
    const places = [];
    const perDayCounter = new Map();

    const nextOrderForDay = (dayIdx) => {
        const current = perDayCounter.get(dayIdx) || 0;
        perDayCounter.set(dayIdx, current + 1);
        return current;
    };

    const rawDaySources = [
        ...(Array.isArray(data.days) ? data.days : []),
        ...(Array.isArray(data.dayPlans) ? data.dayPlans : []),
    ];

    rawDaySources.forEach((rawDay, idx) => {
        if (!rawDay || typeof rawDay !== 'object') return;
        const dayIndex = resolveDayIndex(rawDay, baseStartDate, idx);
        const existing = dayPlansMap.get(dayIndex) || { dayIndex, date: '', theme: '', notes: '' };
        dayPlansMap.set(dayIndex, {
            ...existing,
            dayIndex,
            date: toDateOnly(rawDay.date) || existing.date,
            theme: rawDay.theme ?? rawDay.title ?? existing.theme,
            notes: rawDay.notes ?? existing.notes,
        });

        if (Array.isArray(rawDay.places)) {
            rawDay.places.forEach((rawPlace, pIdx) => {
                const orderIdx = nextOrderForDay(dayIndex);
                const normalized = normalizePlace(rawPlace, dayIndex, orderIdx, places.length + pIdx);
                if (normalized) places.push(normalized);
            });
        }
    });

    if (Array.isArray(data.places)) {
        data.places.forEach((rawPlace, idx) => {
            if (!rawPlace || typeof rawPlace !== 'object') return;
            const dayIndex = resolveDayIndex(rawPlace, baseStartDate, 0);
            const orderIdx = nextOrderForDay(dayIndex);
            const normalized = normalizePlace(rawPlace, dayIndex, orderIdx, places.length + idx);
            if (normalized) places.push(normalized);
        });
    }

    // 若 JSON 未帶入任何顯式景點 (places.length === 0)，但有帶入含日期的 activities，自動將 activities 同步轉為每日排程景點 (places)
    if (places.length === 0 && Array.isArray(activities) && activities.length > 0 && baseStartDate) {
        const sortedActs = [...activities].sort((a, b) =>
            (a.startDate || '').localeCompare(b.startDate || '') ||
            (a.time || '').localeCompare(b.time || '')
        );
        sortedActs.forEach((act, idx) => {
            if (!act.startDate) return;
            const dayIndex = resolveDayIndex({ date: act.startDate }, baseStartDate, 0);
            const orderIdx = nextOrderForDay(dayIndex);
            const normalized = normalizePlace(
                {
                    id: `place_${act.id}`,
                    activityId: act.id,
                    name: act.title,
                    lat: act.lat,
                    lng: act.lng,
                    address: act.location,
                    notes: act.notes,
                    time: act.time,
                    category: act.category,
                    orderIndex: orderIdx,
                },
                dayIndex,
                orderIdx,
                idx
            );
            if (normalized) places.push(normalized);
        });
    }

    const dayPlans = Array.from(dayPlansMap.values()).sort((a, b) => a.dayIndex - b.dayIndex);

    const reservations = Array.isArray(data.reservations)
        ? data.reservations.map((r, i) => normalizeReservation(r, i, baseCurrency)).filter(Boolean)
        : [];
    const expenses = Array.isArray(data.expenses)
        ? data.expenses.map((e, i) => normalizeExpense(e, i, baseCurrency)).filter(Boolean)
        : [];
    const packingItems = Array.isArray(data.packingItems)
        ? data.packingItems.map(normalizePackingItem).filter(Boolean)
        : [];
    const todos = Array.isArray(data.todos)
        ? data.todos.map(normalizeTodo).filter(Boolean)
        : [];

    const hasTripMeta = Boolean(tripMeta && (tripMeta.title || tripMeta.startDate || tripMeta.endDate));
    const hasTripScopedData = Boolean(
        hasTripMeta
        || dayPlans.length > 0
        || places.length > 0
        || reservations.length > 0
        || expenses.length > 0
        || packingItems.length > 0
        || todos.length > 0
    );
    const hasGlobalBookingData = Boolean(
        (tickets && tickets.length > 0)
        || (hotels && hotels.length > 0)
        || (activities && activities.length > 0)
        || hasLabelsKey
        || hasBudgetsKey
        || hasOverridesKey
    );

    const totalItems =
        places.length
        + reservations.length
        + expenses.length
        + packingItems.length
        + todos.length
        + (tickets?.length || 0)
        + (hotels?.length || 0)
        + (activities?.length || 0);

    if (totalItems === 0 && !hasTripMeta && dayPlans.length === 0 && !hasGlobalBookingData) {
        throw new Error(
            '無法識別的 JSON 結構：請至少包含 trip、days、places、reservations、expenses、packingItems、todos、tickets、hotels 或 activities 其中一項'
        );
    }

    return {
        normalized: {
            trip: tripMeta,
            dayPlans,
            places,
            reservations,
            expenses,
            packingItems,
            todos,
            tickets,
            hotels,
            activities,
            tripLabels,
            tripBudgets,
            tripOverrides,
        },
        summary: {
            hasTripMeta,
            tripTitle: tripMeta?.title || '',
            daysCount: dayPlans.length,
            placesCount: places.length,
            reservationsCount: reservations.length,
            expensesCount: expenses.length,
            packingCount: packingItems.length,
            todosCount: todos.length,
            ticketsCount: tickets?.length || 0,
            hotelsCount: hotels?.length || 0,
            activitiesCount: activities?.length || 0,
            hasTripScopedData,
            hasGlobalBookingData,
            totalItems,
        },
    };
}

function mergeArrayById(existing = [], incoming = []) {
    const safeExisting = Array.isArray(existing) ? existing : [];
    const map = new Map();
    safeExisting.forEach((item) => {
        if (item && item.id) map.set(item.id, item);
    });
    incoming.forEach((item) => {
        if (item && item.id) map.set(item.id, item);
    });
    return Array.from(map.values());
}

/**
 * 執行一次性 JSON 匯入（同時寫入 IndexedDB 與 DataContext）
 */
export async function executeUnifiedJsonImport({
    parsed,
    activeTrip = null,
    mode = 'merge', // 'merge' | 'replace'
    tripTarget = 'current', // 'current' | 'new'
    dataSetters = {},
    repos = {
        tripRepo,
        dayPlanRepo,
        placeItemRepo,
        reservationRepo,
        expenseRepo,
        packingRepo,
        todoRepo,
    },
}) {
    const { normalized, summary } = parsed;
    let targetTripId = activeTrip?.id || null;

    // 1. 處理旅程本體 (IndexedDB: trips)
    if (summary.hasTripScopedData) {
        const shouldCreateNewTrip = tripTarget === 'new' || !targetTripId;
        if (shouldCreateNewTrip) {
            const today = new Date().toISOString().slice(0, 10);
            const newId = makeId('trip');
            const newTrip = {
                id: newId,
                title: normalized.trip?.title || '匯入旅程',
                startDate: normalized.trip?.startDate || today,
                endDate: normalized.trip?.endDate || normalized.trip?.startDate || today,
                baseCurrency: normalized.trip?.baseCurrency || 'TWD',
                budget: normalized.trip?.budget || 0,
                destination: normalized.trip?.destination || '',
                status: normalized.trip?.status || 'planning',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            await repos.tripRepo.save(newTrip);
            targetTripId = newId;
        } else if (normalized.trip && activeTrip) {
            const shouldUpdateTitle = mode === 'replace' || !normalized.trip.isInferred || !activeTrip.title || activeTrip.title === '新旅程';
            await repos.tripRepo.save({
                ...activeTrip,
                ...(shouldUpdateTitle && normalized.trip.title ? { title: normalized.trip.title } : {}),
                ...(normalized.trip.startDate ? { startDate: normalized.trip.startDate } : {}),
                ...(normalized.trip.endDate ? { endDate: normalized.trip.endDate } : {}),
                ...(normalized.trip.baseCurrency ? { baseCurrency: normalized.trip.baseCurrency } : {}),
                ...(normalized.trip.budget ? { budget: normalized.trip.budget } : {}),
                ...(normalized.trip.destination ? { destination: normalized.trip.destination } : {}),
                updatedAt: Date.now(),
            });
        }

        // 若為覆寫模式，清除目標旅程既有且本次 JSON 有帶入的子集合
        if (mode === 'replace' && targetTripId && tripTarget === 'current') {
            if (normalized.dayPlans.length > 0) {
                const oldPlans = await repos.dayPlanRepo.getByTrip(targetTripId);
                await Promise.all(oldPlans.map((p) => repos.dayPlanRepo.delete(p.id)));
            }
            if (normalized.places.length > 0) {
                const oldPlaces = await repos.placeItemRepo.getByTrip(targetTripId);
                await Promise.all(oldPlaces.map((p) => repos.placeItemRepo.delete(p.id)));
            }
            if (normalized.reservations.length > 0) {
                const oldRes = await repos.reservationRepo.getByTrip(targetTripId);
                await Promise.all(oldRes.map((r) => repos.reservationRepo.delete(r.id)));
            }
            if (normalized.expenses.length > 0) {
                const oldExp = await repos.expenseRepo.getByTrip(targetTripId);
                await Promise.all(oldExp.map((e) => repos.expenseRepo.delete(e.id)));
            }
            if (normalized.packingItems.length > 0) {
                const oldPack = await repos.packingRepo.getByTrip(targetTripId);
                await Promise.all(oldPack.map((p) => repos.packingRepo.delete(p.id)));
            }
            if (normalized.todos.length > 0) {
                const oldTodos = await repos.todoRepo.getByTrip(targetTripId);
                await Promise.all(oldTodos.map((t) => repos.todoRepo.delete(t.id)));
            }
        }

        // 2. 寫入 DayPlans
        if (normalized.dayPlans.length > 0) {
            const plansToSave = normalized.dayPlans.map((dp) => ({
                ...dp,
                id: `day_${targetTripId}_${dp.dayIndex}`,
                tripId: targetTripId,
            }));
            await repos.dayPlanRepo.saveBatch(plansToSave);
        }

        // 3. 寫入 PlaceItems（合併模式自動接續各日 orderIndex，若 ID 已存在則原地更新避免重複偏移）
        if (normalized.places.length > 0) {
            const existingPlaces = mode === 'merge'
                ? await repos.placeItemRepo.getByTrip(targetTripId).catch(() => [])
                : [];
            const existingPlaceMap = new Map(existingPlaces.map((p) => [p.id, p]));
            const dayOffsetMap = new Map();
            existingPlaces.forEach((p) => {
                const d = p.dayIndex ?? 0;
                dayOffsetMap.set(d, (dayOffsetMap.get(d) || 0) + 1);
            });

            const placesToSave = normalized.places.map((p, idx) => {
                const existing = tripTarget !== 'new' ? existingPlaceMap.get(p.id) : null;
                const offset = (mode === 'merge' && !existing) ? (dayOffsetMap.get(p.dayIndex) || 0) : 0;
                return {
                    ...p,
                    id: tripTarget === 'new' ? makeId('place', idx) : p.id,
                    tripId: targetTripId,
                    orderIndex: existing ? existing.orderIndex : (offset + p.orderIndex),
                };
            });
            await repos.placeItemRepo.saveBatch(placesToSave);
        }

        // 4. 寫入 Reservations
        if (normalized.reservations.length > 0) {
            const resToSave = normalized.reservations.map((r, idx) => ({
                ...r,
                id: tripTarget === 'new' ? makeId('res', idx) : r.id,
                tripId: targetTripId,
            }));
            await repos.reservationRepo.saveBatch(resToSave);
        }

        // 5. 寫入 Expenses
        if (normalized.expenses.length > 0) {
            const expToSave = normalized.expenses.map((e, idx) => ({
                ...e,
                id: tripTarget === 'new' ? makeId('exp', idx) : e.id,
                tripId: targetTripId,
            }));
            await repos.expenseRepo.saveBatch(expToSave);
        }

        // 6. 寫入 PackingItems
        if (normalized.packingItems.length > 0) {
            const packToSave = normalized.packingItems.map((p, idx) => ({
                ...p,
                id: tripTarget === 'new' ? makeId('pack', idx) : p.id,
                tripId: targetTripId,
            }));
            await repos.packingRepo.saveBatch(packToSave);
        }

        // 7. 寫入 Todos
        if (normalized.todos.length > 0) {
            const todoToSave = normalized.todos.map((t, idx) => ({
                ...t,
                id: tripTarget === 'new' ? makeId('todo', idx) : t.id,
                tripId: targetTripId,
            }));
            await repos.todoRepo.saveBatch(todoToSave);
        }
    }

    // 8. 寫入全域票券／住宿／活動（DataContext / LocalStorage）
    const {
        setTickets,
        setHotels,
        setActivities,
        setTripLabels,
        setTripBudgets,
        setOverrides,
    } = dataSetters;

    if (normalized.tickets !== null && typeof setTickets === 'function') {
        setTickets((prev) => (mode === 'replace' ? normalized.tickets : mergeArrayById(prev, normalized.tickets)));
    }
    if (normalized.hotels !== null && typeof setHotels === 'function') {
        setHotels((prev) => (mode === 'replace' ? normalized.hotels : mergeArrayById(prev, normalized.hotels)));
    }
    if (normalized.activities !== null && typeof setActivities === 'function') {
        setActivities((prev) => (mode === 'replace' ? normalized.activities : mergeArrayById(prev, normalized.activities)));
    }
    if (normalized.tripLabels !== null && typeof setTripLabels === 'function') {
        setTripLabels((prev) => (mode === 'replace' ? normalized.tripLabels : { ...(prev || {}), ...normalized.tripLabels }));
    }
    if (normalized.tripBudgets !== null && typeof setTripBudgets === 'function') {
        setTripBudgets((prev) => (mode === 'replace' ? normalized.tripBudgets : { ...(prev || {}), ...normalized.tripBudgets }));
    }
    if (normalized.tripOverrides !== null && typeof setOverrides === 'function') {
        setOverrides((prev) => {
            if (mode === 'replace') return normalized.tripOverrides;
            return {
                version: 1,
                segTripId: { ...(prev?.segTripId || {}), ...(normalized.tripOverrides.segTripId || {}) },
                removedSegIds: Array.from(new Set([...(prev?.removedSegIds || []), ...(normalized.tripOverrides.removedSegIds || [])])),
                tripOrder: normalized.tripOverrides.tripOrder?.length ? normalized.tripOverrides.tripOrder : (prev?.tripOrder || []),
            };
        });
    }

    return {
        targetTripId,
        summary,
    };
}

/**
 * 匯出當前旅程 + 全域票券的完整備份 JSON（可 100% 無損重新匯入）
 */
export function buildFullJsonExport({
    trip = null,
    dayPlans = [],
    places = [],
    reservations = [],
    expenses = [],
    packingItems = [],
    todos = [],
    tickets = [],
    hotels = [],
    activities = [],
    tripLabels = {},
    tripBudgets = {},
    tripOverrides = {},
}) {
    const assembledDays = trip
        ? assembleTripDays({ trip, dayPlans, places }).map((day) => ({
            day: day.dayNumber,
            dayIndex: day.dayIndex,
            date: day.date,
            theme: day.theme || '',
            notes: day.notes || '',
            places: (day.places || []).map((p) => ({
                id: p.id,
                name: p.name,
                lat: p.lat ?? null,
                lng: p.lng ?? null,
                address: p.address || '',
                notes: p.notes || '',
                time: p.time || '',
                category: p.category || '',
                isLocked: Boolean(p.isLocked),
                orderIndex: p.orderIndex ?? 0,
            })),
        }))
        : [];

    return {
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        ...(trip
            ? {
                trip: {
                    title: trip.title,
                    startDate: trip.startDate,
                    endDate: trip.endDate,
                    baseCurrency: trip.baseCurrency || 'TWD',
                    budget: trip.budget || 0,
                    destination: trip.destination || '',
                    status: trip.status || 'planning',
                },
                days: assembledDays,
                reservations: reservations.filter((r) => !r.source),
                expenses,
                packingItems,
                todos,
            }
            : {}),
        tickets,
        hotels,
        activities,
        tripLabels,
        tripBudgets,
        tripOverrides,
    };
}

/**
 * 產生可直接複製給 AI 或手動編輯的標準 JSON 匯入範本
 */
export function getJsonImportTemplate(activeTrip = null) {
    const title = activeTrip?.title || '2026 東京自由行';
    const startDate = activeTrip?.startDate || '2026-12-24';
    const endDate = activeTrip?.endDate || '2026-12-28';

    return {
        schemaVersion: 2,
        trip: {
            title,
            startDate,
            endDate,
            baseCurrency: activeTrip?.baseCurrency || 'TWD',
            budget: 80000,
        },
        days: [
            {
                day: 1,
                date: startDate,
                theme: '抵達與市區散步',
                places: [
                    {
                        name: '淺草寺雷門',
                        lat: 35.7111,
                        lng: 139.7964,
                        address: '東京都台東區淺草 2-3-1',
                        time: '15:00',
                        notes: '傍晚點燈很美',
                    },
                    {
                        name: '東京晴空塔',
                        lat: 35.7101,
                        lng: 139.8107,
                        address: '東京都墨田區押上 1-1-2',
                        time: '18:30',
                        notes: '已預約展望台門票',
                    },
                ],
            },
            {
                day: 2,
                theme: '澀谷原宿購物日',
                places: [
                    {
                        name: '明治神宮',
                        lat: 35.6764,
                        lng: 139.6993,
                        address: '東京都澀谷區代代木神園町 1-1',
                        time: '09:30',
                    },
                    {
                        name: 'SHIBUYA SKY',
                        lat: 35.6584,
                        lng: 139.7022,
                        address: '東京都澀谷區澀谷 2-24-12',
                        time: '16:30',
                    },
                ],
            },
        ],
        tickets: [
            {
                id: 'ticket-sample-01',
                type: 'normal',
                airline: '長榮航空',
                departRegion: 'TPE (台北桃園)',
                returnRegion: 'NRT (東京成田)',
                outboundDate: startDate,
                outboundTime: '08:50',
                outboundArrivalDate: startDate,
                outboundArrivalTime: '13:15',
                outboundFlightNo: 'BR198',
                inboundDate: endDate,
                inboundTime: '14:15',
                inboundArrivalDate: endDate,
                inboundArrivalTime: '16:55',
                inboundFlightNo: 'BR197',
                currency: 'TWD',
                exchangeRate: 1,
                price: 16500,
                priceTWD: 16500,
                isPaid: true,
            },
        ],
        hotels: [
            {
                id: 'hotel-sample-01',
                name: 'Conrad Tokyo',
                address: '1-9-1 Higashi-Shinbashi, Minato-ku, Tokyo',
                checkIn: startDate,
                checkOut: endDate,
                currency: 'JPY',
                priceTotal: 180000,
                priceTWD: 37800,
                confirmationNo: 'H12345678',
                notes: '含早餐',
                isPaid: true,
                lat: 35.6628,
                lng: 139.7611,
            },
        ],
        activities: [
            {
                id: 'activity-sample-01',
                title: 'SHIBUYA SKY 門票',
                category: 'attraction',
                startDate,
                endDate: '',
                time: '16:30',
                location: 'SHIBUYA SKY',
                currency: 'JPY',
                exchangeRate: 0.21,
                price: 2500,
                priceTWD: 525,
                notes: '需提早 15 分鐘入場',
                isPaid: true,
            },
        ],
        expenses: [
            {
                title: '一蘭拉麵晚餐',
                category: 'food',
                amount: 3200,
                currency: 'JPY',
                rateToTripBase: 0.21,
                date: startDate,
                paidBy: '我',
            },
        ],
        packingItems: [
            { itemName: '護照與影本', category: 'essential', weightGrams: 100, isPacked: false },
            { itemName: '日本 eSIM / 行動電源', category: 'electronics', weightGrams: 250, isPacked: false },
        ],
        todos: [
            { title: '填寫 Visit Japan Web', priority: 'high', dueDate: startDate, completed: false },
        ],
    };
}
