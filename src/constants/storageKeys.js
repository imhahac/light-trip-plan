/**
 * storageKeys.js
 * LocalStorage key 單一來源，避免散落 magic string。
 */

export const STORAGE_KEYS = {
    TICKETS: 'reverse-tickets',
    TRIP_LABELS: 'reverse-trip-labels',
    ACTIVITIES: 'reverse-activities',
    HOTELS: 'travel-hotels',
    GOOGLE_ACCESS_TOKEN: 'google-access-token',
    TRIP_OVERRIDES: 'reverse-trip-overrides',
    TIMELINE_SHOW_FUTURE: 'timeline-show-future',
    TIMELINE_SHOW_PAST: 'timeline-show-past',
    TIMELINE_VIEW_MODE: 'timeline-view-mode',
    TIMELINE_DISPLAY_OPTIONS: 'timeline-display-options',
    TRIP_BUDGETS: 'reverse-trip-budgets',
    // ── 畫面配置與視圖狀態持久化 ──
    UI_ACTIVE_TAB: 'ui-active-tab',
    UI_WORKSPACE_TABS: 'ui-workspace-tabs',
    UI_TICKET_SCOPE: 'ui-ticket-scope',
    UI_FILTER_STATUS: 'ui-filter-status',
    TREK_ACTIVE_TRIP_ID: 'trek-active-trip-id',
    TREK_VIEW_MODE: 'trek-view-mode',
    SPLIT_MOBILE_VIEW: 'ui-split-mobile-view',
    PLANNER_SELECTED_DAY_BY_TRIP: 'planner-selected-day-by-trip',
    RESERVATION_CATEGORY: 'ui-reservation-category',
    COST_SCOPE: 'ui-cost-scope',
    COST_SUB_VIEW: 'ui-cost-sub-view',
    COST_SORT_BY: 'ui-cost-sort-by',
    PACKING_SCOPE: 'ui-packing-scope',
    PACKING_SUB_TAB: 'ui-packing-sub-tab',
    PACKING_CATEGORY: 'ui-packing-category',
    PACKING_VISIBILITY: 'ui-packing-visibility',
    PACKING_WEIGHT_ROLLUP: 'ui-packing-weight-rollup',
    PACKING_SHOW_TRASH: 'ui-packing-show-trash',
};
