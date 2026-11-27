/**
 * db/index.js
 * IndexedDB 驅動核心，提供各業務實體的非同步 CRUD 與批次交易操作
 */

import { openDB } from 'idb';
import { DB_NAME, DB_VERSION, STORES, setupIndexedDBSchema } from './schema';

export { STORES, DB_NAME, DB_VERSION };

let dbPromise = null;

export async function getDB() {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                setupIndexedDBSchema(db);
            }
        });
    }
    return dbPromise;
}

/**
 * 安全關閉現有 IndexedDB 連線並等待資料庫徹底刪除（供 ErrorBoundary 自癒重設使用，避免 onblocked）
 */
export async function closeAndDeleteDB() {
    try {
        if (dbPromise) {
            const db = await dbPromise.catch(() => null);
            if (db && typeof db.close === 'function') {
                db.close();
            }
            dbPromise = null;
        }
    } catch {
        dbPromise = null;
    }

    if (typeof window === 'undefined' || !window.indexedDB) return true;
    return new Promise((resolve) => {
        const req = window.indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
        req.onblocked = () => resolve(false);
    });
}

// 明確排除 SYNC_OUTBOX（裝置本機未送出佇列不可污染跨裝置 Drive 備份）
export const SYNCABLE_IDB_STORES = [
    STORES.TRIPS,
    STORES.DAY_PLANS,
    STORES.PLACE_ITEMS,
    STORES.DAY_NOTES,
    STORES.RESERVATIONS,
    STORES.EXPENSES,
    STORES.PACKING_ITEMS,
    STORES.TODOS,
    STORES.ATTACHED_FILES,
    STORES.SETTLEMENT_LOGS,
    STORES.FILE_TRASH,
    STORES.COLLAB_ITEMS,
    STORES.SAVED_TOURS,
];

/**
 * 匯出所有 IndexedDB 核心旅程 Stores（供 Google Drive 完整備份使用）
 */
export async function exportAllIndexedDBData() {
    const db = await getDB();
    const bundle = {};
    for (const storeName of SYNCABLE_IDB_STORES) {
        bundle[storeName] = await db.getAll(storeName).catch(() => []);
    }
    return bundle;
}

/**
 * 在單一跨 Store 原子交易中還原所有 IndexedDB 核心旅程資料
 */
export async function restoreAllIndexedDBData(bundle) {
    if (!bundle || typeof bundle !== 'object') return false;
    const db = await getDB();
    const targetStores = SYNCABLE_IDB_STORES.filter((s) => Array.isArray(bundle[s]));
    if (targetStores.length === 0) return false;

    const tx = db.transaction(targetStores, 'readwrite');
    for (const storeName of targetStores) {
        const store = tx.objectStore(storeName);
        await store.clear();
        for (const item of bundle[storeName]) {
            if (item && item.id) {
                await store.put(item);
            }
        }
    }
    await tx.done;
    return true;
}

// ── Generic Store Operations ──────────────────────────────────────────

async function getAll(storeName) {
    const db = await getDB();
    return db.getAll(storeName);
}

async function getById(storeName, id) {
    const db = await getDB();
    return db.get(storeName, id);
}

async function putItem(storeName, item) {
    const db = await getDB();
    const itemWithTimestamp = {
        ...item,
        updatedAt: item.updatedAt || Date.now()
    };
    await db.put(storeName, itemWithTimestamp);
    return itemWithTimestamp;
}

async function deleteItem(storeName, id) {
    const db = await getDB();
    return db.delete(storeName, id);
}

async function getByIndex(storeName, indexName, value) {
    const db = await getDB();
    return db.getAllFromIndex(storeName, indexName, value);
}

// ── Repositories ──────────────────────────────────────────────────────

export const tripRepo = {
    getAll: () => getAll(STORES.TRIPS),
    get: (id) => getById(STORES.TRIPS, id),
    save: (trip) => putItem(STORES.TRIPS, trip),
    delete: async (id) => {
        const db = await getDB();
        const tx = db.transaction([
            STORES.TRIPS,
            STORES.DAY_PLANS,
            STORES.PLACE_ITEMS,
            STORES.DAY_NOTES,
            STORES.RESERVATIONS,
            STORES.EXPENSES,
            STORES.PACKING_ITEMS,
            STORES.TODOS,
            STORES.ATTACHED_FILES
        ], 'readwrite');

        await tx.objectStore(STORES.TRIPS).delete(id);

        // 1. 級聯刪除日程 (DayPlans) 並蒐集其 ID，以連鎖清理隨手筆記 (DayNotes)
        const dayPlanIds = [];
        const dayPlanIndex = tx.objectStore(STORES.DAY_PLANS).index('tripId');
        let cursor = await dayPlanIndex.openCursor(id);
        while (cursor) {
            dayPlanIds.push(cursor.primaryKey);
            await cursor.delete();
            cursor = await cursor.continue();
        }

        // 2. 級聯刪除日程筆記 (DayNotes)
        if (dayPlanIds.length > 0) {
            const dayNoteIndex = tx.objectStore(STORES.DAY_NOTES).index('dayPlanId');
            for (const planId of dayPlanIds) {
                let noteCursor = await dayNoteIndex.openCursor(planId);
                while (noteCursor) {
                    await noteCursor.delete();
                    noteCursor = await noteCursor.continue();
                }
            }
        }

        // 3. 級聯刪除具備 tripId 索引的其餘 6 個 Store
        const storesWithTripIdIndex = [
            STORES.PLACE_ITEMS,
            STORES.RESERVATIONS,
            STORES.EXPENSES,
            STORES.PACKING_ITEMS,
            STORES.TODOS,
            STORES.ATTACHED_FILES
        ];

        for (const storeName of storesWithTripIdIndex) {
            const index = tx.objectStore(storeName).index('tripId');
            let itemCursor = await index.openCursor(id);
            while (itemCursor) {
                await itemCursor.delete();
                itemCursor = await itemCursor.continue();
            }
        }

        await tx.done;
        return true;
    }
};

export const dayPlanRepo = {
    getByTrip: (tripId) => getByIndex(STORES.DAY_PLANS, 'tripId', tripId),
    get: (id) => getById(STORES.DAY_PLANS, id),
    save: (dayPlan) => putItem(STORES.DAY_PLANS, dayPlan),
    delete: (id) => deleteItem(STORES.DAY_PLANS, id),
    saveBatch: async (dayPlans) => {
        const db = await getDB();
        const tx = db.transaction(STORES.DAY_PLANS, 'readwrite');
        for (const plan of dayPlans) {
            await tx.store.put({ ...plan, updatedAt: Date.now() });
        }
        await tx.done;
        return dayPlans;
    }
};

export const placeItemRepo = {
    getByDayPlan: (dayPlanId) => getByIndex(STORES.PLACE_ITEMS, 'dayPlanId', dayPlanId),
    getByTrip: (tripId) => getByIndex(STORES.PLACE_ITEMS, 'tripId', tripId),
    save: (place) => putItem(STORES.PLACE_ITEMS, place),
    delete: (id) => deleteItem(STORES.PLACE_ITEMS, id),
    saveBatch: async (places) => {
        const db = await getDB();
        const tx = db.transaction(STORES.PLACE_ITEMS, 'readwrite');
        for (const place of places) {
            await tx.store.put({ ...place, updatedAt: Date.now() });
        }
        await tx.done;
        return places;
    }
};

export const dayNoteRepo = {
    getByDayPlan: (dayPlanId) => getByIndex(STORES.DAY_NOTES, 'dayPlanId', dayPlanId),
    save: (note) => putItem(STORES.DAY_NOTES, note),
    delete: (id) => deleteItem(STORES.DAY_NOTES, id)
};

export const reservationRepo = {
    getByTrip: (tripId) => getByIndex(STORES.RESERVATIONS, 'tripId', tripId),
    get: (id) => getById(STORES.RESERVATIONS, id),
    save: (reservation) => putItem(STORES.RESERVATIONS, reservation),
    delete: (id) => deleteItem(STORES.RESERVATIONS, id),
    saveBatch: async (reservations) => {
        const db = await getDB();
        const tx = db.transaction(STORES.RESERVATIONS, 'readwrite');
        for (const res of reservations) {
            await tx.store.put({ ...res, updatedAt: Date.now() });
        }
        await tx.done;
        return reservations;
    }
};

export const expenseRepo = {
    getAll: () => getAll(STORES.EXPENSES),
    getByTrip: (tripId) => getByIndex(STORES.EXPENSES, 'tripId', tripId),
    get: (id) => getById(STORES.EXPENSES, id),
    save: (expense) => putItem(STORES.EXPENSES, expense),
    delete: (id) => deleteItem(STORES.EXPENSES, id),
    saveBatch: async (expenses) => {
        const db = await getDB();
        const tx = db.transaction(STORES.EXPENSES, 'readwrite');
        for (const exp of expenses) {
            await tx.store.put({ ...exp, updatedAt: Date.now() });
        }
        await tx.done;
        return expenses;
    }
};

export const packingRepo = {
    getAll: () => getAll(STORES.PACKING_ITEMS),
    getByTrip: (tripId) => getByIndex(STORES.PACKING_ITEMS, 'tripId', tripId),
    save: (item) => putItem(STORES.PACKING_ITEMS, item),
    delete: (id) => deleteItem(STORES.PACKING_ITEMS, id),
    saveBatch: async (items) => {
        const db = await getDB();
        const tx = db.transaction(STORES.PACKING_ITEMS, 'readwrite');
        for (const item of items) {
            await tx.store.put({ ...item, updatedAt: Date.now() });
        }
        await tx.done;
        return items;
    }
};

export const todoRepo = {
    getAll: () => getAll(STORES.TODOS),
    getByTrip: (tripId) => getByIndex(STORES.TODOS, 'tripId', tripId),
    save: (todo) => putItem(STORES.TODOS, todo),
    delete: (id) => deleteItem(STORES.TODOS, id),
    saveBatch: async (todos) => {
        const db = await getDB();
        const tx = db.transaction(STORES.TODOS, 'readwrite');
        for (const td of todos) {
            await tx.store.put({ ...td, updatedAt: Date.now() });
        }
        await tx.done;
        return todos;
    }
};

export const fileRepo = {
    getAll: () => getAll(STORES.ATTACHED_FILES),
    getByParent: (parentId) => getByIndex(STORES.ATTACHED_FILES, 'parentId', parentId),
    getByTrip: (tripId) => getByIndex(STORES.ATTACHED_FILES, 'tripId', tripId),
    save: (file) => putItem(STORES.ATTACHED_FILES, file),
    moveToTrash: async (id) => {
        const file = await getById(STORES.ATTACHED_FILES, id);
        if (file) {
            await putItem(STORES.ATTACHED_FILES, {
                ...file,
                isTrash: true,
                trashedAt: Date.now()
            });
        }
    },
    restore: async (id) => {
        const file = await getById(STORES.ATTACHED_FILES, id);
        if (file) {
            await putItem(STORES.ATTACHED_FILES, {
                ...file,
                isTrash: false,
                trashedAt: null
            });
        }
    },
    permanentDelete: (id) => deleteItem(STORES.ATTACHED_FILES, id)
};

export const settingsRepo = {
    get: async (key, defaultValue = null) => {
        const db = await getDB();
        const res = await db.get(STORES.APP_SETTINGS, key);
        return res ? res.value : defaultValue;
    },
    set: async (key, value) => {
        const db = await getDB();
        await db.put(STORES.APP_SETTINGS, { key, value, updatedAt: Date.now() });
        return value;
    }
};

export const backupRepo = {
    getAll: () => getAll(STORES.BACKUPS),
    createBackup: async (label, payload) => {
        const db = await getDB();
        const id = 'backup_' + Date.now();
        const item = {
            id,
            label,
            createdAt: Date.now(),
            payload
        };
        await db.put(STORES.BACKUPS, item);
        return item;
    },
    get: (id) => getById(STORES.BACKUPS, id),
    delete: (id) => deleteItem(STORES.BACKUPS, id)
};

export const settlementLogRepo = {
    getByTrip: (tripId) => getByIndex(STORES.SETTLEMENT_LOGS, 'tripId', tripId),
    save: (entry) => putItem(STORES.SETTLEMENT_LOGS, entry),
    delete: (id) => deleteItem(STORES.SETTLEMENT_LOGS, id),
};

export const fileTrashRepo = {
    getByTrip: (tripId) => getByIndex(STORES.FILE_TRASH, 'tripId', tripId),
    getAll: () => getAll(STORES.FILE_TRASH),
    save: (item) => putItem(STORES.FILE_TRASH, { ...item, trashedAt: item.trashedAt || Date.now() }),
    delete: (id) => deleteItem(STORES.FILE_TRASH, id),
};

export const syncOutboxRepo = {
    getAll: () => getAll(STORES.SYNC_OUTBOX),
    getPending: () => getByIndex(STORES.SYNC_OUTBOX, 'status', 'pending'),
    save: (item) => putItem(STORES.SYNC_OUTBOX, { ...item, status: item.status || 'pending', createdAt: item.createdAt || Date.now() }),
    delete: (id) => deleteItem(STORES.SYNC_OUTBOX, id),
    clearAll: async () => {
        const db = await getDB();
        await db.clear(STORES.SYNC_OUTBOX);
    },
};

export const collabItemRepo = {
    getByTrip: (tripId) => getByIndex(STORES.COLLAB_ITEMS, 'tripId', tripId),
    save: (item) => putItem(STORES.COLLAB_ITEMS, item),
    delete: (id) => deleteItem(STORES.COLLAB_ITEMS, id),
};

export const savedTourRepo = {
    getAll: () => getAll(STORES.SAVED_TOURS),
    getByTrip: (tripId) => getByIndex(STORES.SAVED_TOURS, 'tripId', tripId),
    save: (tour) => {
        const pts = Array.isArray(tour?.points) ? tour.points : [];
        let leanPoints = pts;
        if (pts.length > 500) {
            const step = (pts.length - 1) / 499;
            leanPoints = Array.from({ length: 500 }, (_, i) => pts[Math.round(i * step)]);
        }
        return putItem(STORES.SAVED_TOURS, { ...tour, points: leanPoints, createdAt: tour.createdAt || Date.now() });
    },
    delete: (id) => deleteItem(STORES.SAVED_TOURS, id),
};
