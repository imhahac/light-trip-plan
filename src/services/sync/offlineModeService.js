/**
 * offlineModeService.js
 * Global manual offline-mode toggle so users can purposefully switch Light Trip Plan offline.
 */

const STORAGE_KEY = 'ltp_manual_offline_mode';
const EVENT_NAME = 'ltp-offline-mode-change';

export function isManualOfflineMode() {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return false;
        return window.localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

export function setManualOfflineMode(enabled) {
    const val = Boolean(enabled);
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(STORAGE_KEY, val ? 'true' : 'false');
            window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { offline: val } }));
        }
    } catch {
        // ignore storage errors
    }
    return val;
}

export function isEffectivelyOffline() {
    if (isManualOfflineMode()) return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return false;
}

export function subscribeOfflineMode(listener) {
    if (typeof window === 'undefined') return () => {};
    const handler = () => listener(isEffectivelyOffline(), isManualOfflineMode());
    window.addEventListener(EVENT_NAME, handler);
    window.addEventListener('online', handler);
    window.addEventListener('offline', handler);
    return () => {
        window.removeEventListener(EVENT_NAME, handler);
        window.removeEventListener('online', handler);
        window.removeEventListener('offline', handler);
    };
}
