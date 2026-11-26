/**
 * ThemeContext.jsx
 * Appearance & Accessibility preferences:
 * - mode: 'light' | 'dark' | 'system'
 * - accent: 7 color schemes ('indigo' | 'emerald' | 'rose' | 'amber' | 'sky' | 'violet' | 'slate')
 * - textSize: 'sm' | 'md' | 'lg'
 * - density: 'comfortable' | 'compact'
 * - reducedMotion: boolean
 */
import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';

const STORAGE_KEY = 'ltp_appearance_prefs';

export const ACCENT_SCHEMES = [
    { id: 'indigo', label: '靛藍', hex: '#4f46e5', hover: '#4338ca', soft: '#eef2ff', border: '#c7d2fe' },
    { id: 'emerald', label: '翡翠', hex: '#059669', hover: '#047857', soft: '#ecfdf5', border: '#a7f3d0' },
    { id: 'rose', label: '玫瑰', hex: '#e11d48', hover: '#be123c', soft: '#fff1f2', border: '#fecdd3' },
    { id: 'amber', label: '琥珀', hex: '#d97706', hover: '#b45309', soft: '#fffbeb', border: '#fde68a' },
    { id: 'sky', label: '天藍', hex: '#0284c7', hover: '#0369a1', soft: '#f0f9ff', border: '#bae6fd' },
    { id: 'violet', label: '紫羅蘭', hex: '#7c3aed', hover: '#6d28d9', soft: '#f5f3ff', border: '#ddd6fe' },
    { id: 'slate', label: '石墨', hex: '#334155', hover: '#1e293b', soft: '#f1f5f9', border: '#cbd5e1' },
];

const DEFAULT_PREFS = {
    mode: 'light',
    accent: 'indigo',
    textSize: 'md',
    density: 'comfortable',
    reducedMotion: false,
};

function loadPrefs() {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_PREFS;
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_PREFS;
        return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    } catch {
        return DEFAULT_PREFS;
    }
}

const ThemeContext = createContext({
    prefs: DEFAULT_PREFS,
    resolvedTheme: 'light',
    updatePrefs: () => {},
    resetPrefs: () => {},
});

export function ThemeProvider({ children }) {
    const [prefs, setPrefs] = useState(loadPrefs);
    const [systemDark, setSystemDark] = useState(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return false;
        return window.matchMedia('(prefers-color-scheme: dark)').matches;
    });

    useEffect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = (e) => setSystemDark(e.matches);
        mq.addEventListener?.('change', handler);
        return () => mq.removeEventListener?.('change', handler);
    }, []);

    const resolvedTheme = prefs.mode === 'system' ? (systemDark ? 'dark' : 'light') : prefs.mode;

    useEffect(() => {
        if (typeof document === 'undefined') return;
        const root = document.documentElement;
        root.setAttribute('data-theme', resolvedTheme);
        root.classList.toggle('dark', resolvedTheme === 'dark');
        root.setAttribute('data-accent', prefs.accent || 'indigo');
        root.setAttribute('data-density', prefs.density || 'comfortable');
        root.setAttribute('data-reduced-motion', prefs.reducedMotion ? 'true' : 'false');

        const accentObj = ACCENT_SCHEMES.find((a) => a.id === prefs.accent) || ACCENT_SCHEMES[0];
        root.style.setProperty('--ltp-accent', accentObj.hex);
        root.style.setProperty('--ltp-accent-hover', accentObj.hover);
        root.style.setProperty('--ltp-accent-soft', accentObj.soft);
        root.style.setProperty('--ltp-accent-border', accentObj.border);

        const sizeMap = { sm: '14px', md: '16px', lg: '18px' };
        root.style.fontSize = sizeMap[prefs.textSize] || '16px';

        try {
            window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
        } catch {
            // ignore storage errors
        }
    }, [prefs, resolvedTheme]);

    const updatePrefs = (patch) => setPrefs((prev) => ({ ...prev, ...patch }));
    const resetPrefs = () => setPrefs(DEFAULT_PREFS);

    const value = useMemo(() => ({ prefs, resolvedTheme, updatePrefs, resetPrefs }), [prefs, resolvedTheme]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
    return useContext(ThemeContext);
}
