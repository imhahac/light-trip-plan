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
