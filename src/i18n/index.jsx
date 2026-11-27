/**
 * Lightweight zero-dependency i18n context for Light Trip Plan (zh-TW / en / ja).
 * New Phase 1–4 UI uses t(key, fallback) from Day 1; existing strings remain backward-compatible.
 */
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

const STORAGE_KEY = 'ltp_locale';
export const SUPPORTED_LOCALES = [
    { code: 'zh-TW', label: '繁體中文' },
    { code: 'en', label: 'English' },
    { code: 'ja', label: '日本語' },
];

const DICTIONARIES = {
    'zh-TW': {
        'undo.undo': '復原',
        'undo.redo': '重做',
        'undo.undone': '已復原上一步操作',
        'undo.redone': '已重做操作',
        'map.terrain3d': '3D 地形',
        'map.cluster': '聚合標記',
        'map.fullTrip': '全行程總覽',
        'map.addToDay': '加入行程',
        'map.openInNav': '開啟導航',
        'transit.title': '大眾運輸規劃',
        'transit.loading': '正在查詢 Transitous 大眾運輸路線...',
        'transit.fallback': '查無即時轉乘資料，改以 Google Maps 開啟',
        'roadtrip.title': '公路旅行模式',
        'roadtrip.window': '每日行車時段',
        'roadtrip.dwell': '預設停留 (分)',
        'roadtrip.overrun': '超出當日行車時段',
        'gpx.elevationTitle': 'GPX 海拔剖面與軌跡分析',
        'gpx.compareRecorded': '掛載實錄 GPX 對比',
        'gpx.distance': '總距離',
        'gpx.ascent': '總爬升',
        'gpx.descent': '總下降',
        'gpx.duration': '耗時',
        'appearance.title': '外觀主題與語系設定',
        'appearance.colorMode': '色彩模式',
        'appearance.light': '淺色',
        'appearance.dark': '深色',
        'appearance.system': '跟隨系統',
        'appearance.accent': '主題強調色 (7 色)',
        'appearance.textSize': '文字大小',
        'appearance.textSm': '精巧 (Small)',
        'appearance.textMd': '標準 (Medium)',
        'appearance.textLg': '放大 (Large)',
        'appearance.density': '介面密度',
        'appearance.comfortable': '舒適 (Comfortable)',
        'appearance.compact': '緊湊 (Compact)',
        'appearance.language': '介面語言 (i18n)',
        'appearance.reducedMotion': '減少動畫與動態效果 (Reduced Motion)',
        'appearance.reset': '重設為預設值',
        'appearance.done': '完成',
        'header.online': '線上',
        'header.offline': '離線模式',
        'header.exportImport': '匯入匯出 & 手冊',
        'header.googleLogin': 'Google 登入',
        'header.googleConnected': 'Google 已連結',
        'help.title': 'Light Trip Plan 快速上手指南 (離線可用)',
        'help.searchPlaceholder': '搜尋指南（例：GPX、離線、分帳、收據、子金鑰）...',
        'help.shortcuts': '常用快捷鍵',
        'ws.planning': '🗺️ 行程工作台',
        'ws.finance': '💰 財務中心',
        'ws.prep': '🎒 整備中心',
        'ws.tickets': '🎟️ 票券憑證',
        'tab.planner': '⚡ 每日排程時間表',
        'tab.timeline': '📆 旅程全景時間軸',
        'tab.reservations': '🎟️ 預訂總覽',
        'tab.calendar': '📅 月曆視圖',
        'tab.map': '🌐 航線地圖',
        'tab.costs': '💰 財務總覽與記帳',
        'tab.packing': '🧳 行李、待辦與大檔',
        'tab.list': '✈️ 機票管理',
        'tab.hotels': '🏨 飯店管理',
        'tab.activities': '🎫 票券與活動',
    },
    en: {
        'undo.undo': 'Undo',
        'undo.redo': 'Redo',
        'undo.undone': 'Undid last change',
        'undo.redone': 'Redid change',
        'map.terrain3d': '3D Terrain',
        'map.cluster': 'Cluster',
        'map.fullTrip': 'Whole Trip',
        'map.addToDay': 'Add to Day',
        'map.openInNav': 'Navigate',
        'transit.title': 'Public Transit',
        'transit.loading': 'Querying Transitous public transit...',
        'transit.fallback': 'No live transit route found; open in Google Maps',
        'roadtrip.title': 'Road Trip Mode',
        'roadtrip.window': 'Driving Window',
        'roadtrip.dwell': 'Default Dwell (min)',
        'roadtrip.overrun': 'Exceeds daily driving window',
        'gpx.elevationTitle': 'GPX Elevation & Track Analysis',
        'gpx.compareRecorded': 'Compare Recorded GPX',
        'gpx.distance': 'Distance',
        'gpx.ascent': 'Ascent',
        'gpx.descent': 'Descent',
        'gpx.duration': 'Duration',
        'appearance.title': 'Appearance & Language',
        'appearance.colorMode': 'Color Mode',
        'appearance.light': 'Light',
        'appearance.dark': 'Dark',
        'appearance.system': 'System',
        'appearance.accent': 'Accent Color (7 Schemes)',
        'appearance.textSize': 'Text Size',
        'appearance.textSm': 'Small',
        'appearance.textMd': 'Medium',
        'appearance.textLg': 'Large',
        'appearance.density': 'Density',
        'appearance.comfortable': 'Comfortable',
        'appearance.compact': 'Compact',
        'appearance.language': 'Language (i18n)',
        'appearance.reducedMotion': 'Reduced Motion',
        'appearance.reset': 'Reset Defaults',
        'appearance.done': 'Done',
        'header.online': 'Online',
        'header.offline': 'Offline',
        'header.exportImport': 'Import / Export & PDF',
        'header.googleLogin': 'Sign in with Google',
        'header.googleConnected': 'Google Synced',
        'help.title': 'Light Trip Plan Quick Guide (Offline Ready)',
        'help.searchPlaceholder': 'Search guides (e.g. GPX, offline, split, receipt)...',
        'help.shortcuts': 'Keyboard Shortcuts',
        'ws.planning': '🗺️ Planning',
        'ws.finance': '💰 Finance',
        'ws.prep': '🎒 Packing & Prep',
        'ws.tickets': '🎟️ Bookings',
        'tab.planner': '⚡ Day Planner',
        'tab.timeline': '📆 Full Timeline',
        'tab.reservations': '🎟️ Reservations',
        'tab.calendar': '📅 Calendar',
        'tab.map': '🌐 Route Map',
        'tab.costs': '💰 Costs & Split',
        'tab.packing': '🧳 Packing, Todos & Files',
        'tab.list': '✈️ Flights',
        'tab.hotels': '🏨 Hotels',
        'tab.activities': '🎫 Activities',
    },
    ja: {
        'undo.undo': '元に戻す',
        'undo.redo': 'やり直す',
        'undo.undone': '操作を元に戻しました',
        'undo.redone': '操作をやり直しました',
        'map.terrain3d': '3D 地形',
        'map.cluster': 'クラスター',
        'map.fullTrip': '全行程ルート',
        'map.addToDay': '日程に追加',
        'map.openInNav': 'ナビで開く',
        'transit.title': '公共交通ルート',
        'transit.loading': 'Transitous 乗換案内を検索中...',
        'transit.fallback': '経路が見つかりません。Google マップで開きます',
        'roadtrip.title': 'ロードトリップモード',
        'roadtrip.window': '運転時間帯',
        'roadtrip.dwell': '標準滞在 (分)',
        'roadtrip.overrun': '当日の運転時間を超過',
        'gpx.elevationTitle': 'GPX 標高プロファイル・軌跡分析',
        'gpx.compareRecorded': '実測 GPX と比較',
        'gpx.distance': '総距離',
        'gpx.ascent': '獲得標高',
        'gpx.descent': '累積下降',
        'gpx.duration': '所要時間',
        'appearance.title': '外観テーマと言語設定',
        'appearance.colorMode': 'カラーモード',
        'appearance.light': 'ライト',
        'appearance.dark': 'ダーク',
        'appearance.system': 'システム',
        'appearance.accent': 'アクセントカラー (7色)',
        'appearance.textSize': '文字サイズ',
        'appearance.textSm': '小 (Small)',
        'appearance.textMd': '標準 (Medium)',
        'appearance.textLg': '大 (Large)',
        'appearance.density': '表示密度',
        'appearance.comfortable': '標準 (Comfortable)',
        'appearance.compact': 'コンパクト (Compact)',
        'appearance.language': '表示言語 (i18n)',
        'appearance.reducedMotion': '視差効果・アニメーションを減らす',
        'appearance.reset': '初期設定に戻す',
        'appearance.done': '完了',
        'header.online': 'オンライン',
        'header.offline': 'オフライン',
        'header.exportImport': '入出力・PDF しおり',
        'header.googleLogin': 'Google ログイン',
        'header.googleConnected': 'Google 連携済',
        'help.title': 'Light Trip Plan クイックガイド (オフライン対応)',
        'help.searchPlaceholder': 'ガイドを検索（例：GPX、オフライン、精算）...',
        'help.shortcuts': 'ショートカットキー',
        'ws.planning': '🗺️ 行程プランナー',
        'ws.finance': '💰 費用・精算',
        'ws.prep': '🎒 持ち物・準備',
        'ws.tickets': '🎟️ 予約・チケット',
        'tab.planner': '⚡ 日別スケジュール',
        'tab.timeline': '📆 全体タイムライン',
        'tab.reservations': '🎟️ 予約一覧',
        'tab.calendar': '📅 カレンダー',
        'tab.map': '🌐 航路マップ',
        'tab.costs': '💰 費用と割り勘',
        'tab.packing': '🧳 持ち物・ToDo・ファイル',
        'tab.list': '✈️ 航空券',
        'tab.hotels': '🏨 ホテル',
        'tab.activities': '🎫 体験・チケット',
    },
};

const I18nContext = createContext({
    locale: 'zh-TW',
    setLocale: () => {},
    t: (key, fallback) => fallback || DICTIONARIES['zh-TW'][key] || key,
});

export function I18nProvider({ children }) {
    const [locale, setLocaleState] = useState(() => {
        try {
            const saved = typeof window !== 'undefined' ? window.localStorage?.getItem(STORAGE_KEY) : null;
            if (saved && DICTIONARIES[saved]) return saved;
        } catch {
            // ignore storage errors
        }
        return 'zh-TW';
    });

    const setLocale = useCallback((next) => {
        if (!DICTIONARIES[next]) return;
        setLocaleState(next);
        try {
            if (typeof window !== 'undefined') {
                window.localStorage?.setItem(STORAGE_KEY, next);
            }
        } catch {
            // ignore
        }
    }, []);

    const t = useCallback((key, fallback) => {
        const dict = DICTIONARIES[locale] || DICTIONARIES['zh-TW'];
        return dict[key] || DICTIONARIES['zh-TW'][key] || fallback || key;
    }, [locale]);

    const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
    return useContext(I18nContext);
}
