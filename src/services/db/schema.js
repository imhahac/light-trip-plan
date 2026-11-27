/**
 * schema.js
 * IndexedDB Schema 定義與版本管理
 */

export const DB_NAME = 'treklite_db';
export const DB_VERSION = 4;

export const STORES = {
    TRIPS: 'trips',
    DAY_PLANS: 'dayPlans',
    PLACE_ITEMS: 'placeItems',
    DAY_NOTES: 'dayNotes',
    RESERVATIONS: 'reservations',
    EXPENSES: 'expenses',
    PACKING_ITEMS: 'packingItems',
    TODOS: 'todos',
    ATTACHED_FILES: 'attachedFiles',
    APP_SETTINGS: 'appSettings',
    BACKUPS: 'backups',
    // v2 單軌收斂：將原 localStorage 票券／住宿／活動同步納管至 IndexedDB
    TICKETS: 'tickets',
    HOTELS: 'hotels',
    ACTIVITIES: 'activities',
    // v3 Light TREK 升級：離線佇列、結算日誌、檔案回收桶、非同步旅伴協作
    SYNC_OUTBOX: 'syncOutbox',
    SETTLEMENT_LOGS: 'settlementLogs',
    FILE_TRASH: 'fileTrash',
    COLLAB_ITEMS: 'collabItems',
    // v4 Light Tours：持久化 GPX 戶外軌跡收藏庫
    SAVED_TOURS: 'savedTours',
};

export function setupIndexedDBSchema(db) {
    // 1. Trips
    if (!db.objectStoreNames.contains(STORES.TRIPS)) {
        const store = db.createObjectStore(STORES.TRIPS, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('startDate', 'startDate', { unique: false });
    }

    // 2. DayPlans
    if (!db.objectStoreNames.contains(STORES.DAY_PLANS)) {
        const store = db.createObjectStore(STORES.DAY_PLANS, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('tripId_dayIndex', ['tripId', 'dayIndex'], { unique: false });
    }

    // 3. PlaceItems
    if (!db.objectStoreNames.contains(STORES.PLACE_ITEMS)) {
        const store = db.createObjectStore(STORES.PLACE_ITEMS, { keyPath: 'id' });
        store.createIndex('dayPlanId', 'dayPlanId', { unique: false });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('orderIndex', 'orderIndex', { unique: false });
    }

    // 4. DayNotes
    if (!db.objectStoreNames.contains(STORES.DAY_NOTES)) {
        const store = db.createObjectStore(STORES.DAY_NOTES, { keyPath: 'id' });
        store.createIndex('dayPlanId', 'dayPlanId', { unique: false });
    }

    // 5. Reservations (16 Types)
    if (!db.objectStoreNames.contains(STORES.RESERVATIONS)) {
        const store = db.createObjectStore(STORES.RESERVATIONS, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('type', 'type', { unique: false });
        store.createIndex('startDate', 'startDate', { unique: false });
    }

    // 6. Expenses
    if (!db.objectStoreNames.contains(STORES.EXPENSES)) {
        const store = db.createObjectStore(STORES.EXPENSES, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('category', 'category', { unique: false });
    }

    // 7. Packing Items
    if (!db.objectStoreNames.contains(STORES.PACKING_ITEMS)) {
        const store = db.createObjectStore(STORES.PACKING_ITEMS, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('category', 'category', { unique: false });
    }

    // 8. Todos
    if (!db.objectStoreNames.contains(STORES.TODOS)) {
        const store = db.createObjectStore(STORES.TODOS, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('dueDate', 'dueDate', { unique: false });
    }

    // 9. Attached Files
    if (!db.objectStoreNames.contains(STORES.ATTACHED_FILES)) {
        const store = db.createObjectStore(STORES.ATTACHED_FILES, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('parentId', 'parentId', { unique: false });
        store.createIndex('isTrash', 'isTrash', { unique: false });
    }

    // 10. App Settings
    if (!db.objectStoreNames.contains(STORES.APP_SETTINGS)) {
        db.createObjectStore(STORES.APP_SETTINGS, { keyPath: 'key' });
    }

    // 11. Backups
    if (!db.objectStoreNames.contains(STORES.BACKUPS)) {
        const store = db.createObjectStore(STORES.BACKUPS, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
    }

    // 12. Tickets (v2 單軌整合)
    if (!db.objectStoreNames.contains(STORES.TICKETS)) {
        const store = db.createObjectStore(STORES.TICKETS, { keyPath: 'id' });
        store.createIndex('outboundDate', 'outboundDate', { unique: false });
    }

    // 13. Hotels (v2 單軌整合)
    if (!db.objectStoreNames.contains(STORES.HOTELS)) {
        const store = db.createObjectStore(STORES.HOTELS, { keyPath: 'id' });
        store.createIndex('checkIn', 'checkIn', { unique: false });
    }

    // 14. Activities (v2 單軌整合)
    if (!db.objectStoreNames.contains(STORES.ACTIVITIES)) {
        const store = db.createObjectStore(STORES.ACTIVITIES, { keyPath: 'id' });
        store.createIndex('startDate', 'startDate', { unique: false });
    }

    // 15. Sync Outbox (v3 裝置本機離線變更佇列，不納入跨裝置備份)
    if (!db.objectStoreNames.contains(STORES.SYNC_OUTBOX)) {
        const store = db.createObjectStore(STORES.SYNC_OUTBOX, { keyPath: 'id' });
        store.createIndex('channel', 'channel', { unique: false });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
    }

    // 16. Settlement Logs (v3 分帳結清歷史日誌)
    if (!db.objectStoreNames.contains(STORES.SETTLEMENT_LOGS)) {
        const store = db.createObjectStore(STORES.SETTLEMENT_LOGS, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('settledAt', 'settledAt', { unique: false });
    }

    // 17. File Trash (v3 附件回收桶，保留 30 天可還原)
    if (!db.objectStoreNames.contains(STORES.FILE_TRASH)) {
        const store = db.createObjectStore(STORES.FILE_TRASH, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('trashedAt', 'trashedAt', { unique: false });
    }

    // 18. Collab Items (v3 非同步旅伴共筆：筆記、連結、投票、What's Next)
    if (!db.objectStoreNames.contains(STORES.COLLAB_ITEMS)) {
        const store = db.createObjectStore(STORES.COLLAB_ITEMS, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('kind', 'kind', { unique: false });
    }

    // 19. Saved Tours (v4 持久化 GPX 戶外軌跡收藏庫)
    if (!db.objectStoreNames.contains(STORES.SAVED_TOURS)) {
        const store = db.createObjectStore(STORES.SAVED_TOURS, { keyPath: 'id' });
        store.createIndex('tripId', 'tripId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
    }
}
