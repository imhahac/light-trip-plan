/**
 * AppearanceSettingsModal.jsx
 * Theme (Light/Dark/System), 7 Accent Colors, Text Size, Density, Reduced Motion & Language (zh-TW/en/ja).
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { Sun, Moon, Monitor, Palette, Globe, X, RotateCcw } from 'lucide-react';
import { useTheme, ACCENT_SCHEMES } from '../../contexts/ThemeContext';
import { useI18n, SUPPORTED_LOCALES } from '../../i18n';

export default function AppearanceSettingsModal({ isOpen, onClose }) {
    const { prefs, updatePrefs, resetPrefs } = useTheme();
    const { locale, setLocale, t } = useI18n();

    if (!isOpen) return null;

    const content = (
        <div className="fixed inset-0 z-[85] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
            <div
                className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl border border-slate-200 text-slate-800 space-y-4"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <h3 className="font-extrabold text-sm flex items-center gap-2">
                        <Palette className="w-4 h-4 text-indigo-600" />
                        <span>{t('appearance.title', '外觀主題與語系設定')}</span>
                    </h3>
                    <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* 1. 淺色 / 深色 / 跟隨系統 */}
                <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600">{t('appearance.colorMode', '色彩模式')}</label>
                    <div className="grid grid-cols-3 gap-2">
                        {[
                            { id: 'light', label: t('appearance.light', '淺色'), icon: Sun },
                            { id: 'dark', label: t('appearance.dark', '深色'), icon: Moon },
                            { id: 'system', label: t('appearance.system', '跟隨系統'), icon: Monitor },
                        ].map((m) => {
                            const Icon = m.icon;
                            return (
                                <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => updatePrefs({ mode: m.id })}
                                    className={`py-2 px-3 rounded-xl text-xs font-bold border flex items-center justify-center gap-1.5 transition ${
                                        prefs.mode === m.id
                                            ? 'bg-indigo-600 text-white border-indigo-600'
                                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                                    }`}
                                >
                                    <Icon className="w-3.5 h-3.5" />
                                    <span>{m.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* 2. 七種主題強調色 */}
                <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600">{t('appearance.accent', '主題強調色 (7 色)')}</label>
                    <div className="flex flex-wrap items-center gap-2">
                        {ACCENT_SCHEMES.map((a) => (
                            <button
                                key={a.id}
                                type="button"
                                onClick={() => updatePrefs({ accent: a.id })}
                                title={a.label}
                                className={`w-8 h-8 rounded-full border-2 transition flex items-center justify-center ${
                                    prefs.accent === a.id ? 'ring-2 ring-offset-2 ring-slate-900 scale-110' : 'border-white shadow'
                                }`}
                                style={{ backgroundColor: a.hex }}
                            />
                        ))}
                    </div>
                </div>

                {/* 3. 字體大小 & 介面密度 */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="space-y-1">
                        <label className="font-bold text-slate-600">{t('appearance.textSize', '文字大小')}</label>
                        <select
                            value={prefs.textSize}
                            onChange={(e) => updatePrefs({ textSize: e.target.value })}
                            className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
                        >
                            <option value="sm">{t('appearance.textSm', '精巧 (Small)')}</option>
                            <option value="md">{t('appearance.textMd', '標準 (Medium)')}</option>
                            <option value="lg">{t('appearance.textLg', '放大 (Large)')}</option>
                        </select>
                    </div>
                    <div className="space-y-1">
                        <label className="font-bold text-slate-600">{t('appearance.density', '介面密度')}</label>
                        <select
                            value={prefs.density}
                            onChange={(e) => updatePrefs({ density: e.target.value })}
                            className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white"
                        >
                            <option value="comfortable">{t('appearance.comfortable', '舒適 (Comfortable)')}</option>
                            <option value="compact">{t('appearance.compact', '緊湊 (Compact)')}</option>
                        </select>
                    </div>
                </div>

                {/* 4. 語系切換 (中/英/日) */}
                <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-600 flex items-center gap-1">
                        <Globe className="w-3.5 h-3.5 text-indigo-600" />
                        <span>{t('appearance.language', '介面語言 (i18n)')}</span>
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                        {SUPPORTED_LOCALES.map((loc) => (
                            <button
                                key={loc.code}
                                type="button"
                                onClick={() => setLocale(loc.code)}
                                className={`py-1.5 px-2 rounded-lg text-xs font-bold border transition ${
                                    locale === loc.code
                                        ? 'bg-indigo-600 text-white border-indigo-600'
                                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                                }`}
                            >
                                {loc.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* 5. 減少動態效果 */}
                <label className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-xs cursor-pointer">
                    <span className="font-bold text-slate-700">{t('appearance.reducedMotion', '減少動畫與動態效果 (Reduced Motion)')}</span>
                    <input
                        type="checkbox"
                        checked={Boolean(prefs.reducedMotion)}
                        onChange={(e) => updatePrefs({ reducedMotion: e.target.checked })}
                        className="rounded text-indigo-600"
                    />
                </label>

                <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                    <button
                        type="button"
                        onClick={resetPrefs}
                        className="text-xs text-slate-500 hover:text-slate-800 flex items-center gap-1 font-semibold"
                    >
                        <RotateCcw className="w-3.5 h-3.5" /> {t('appearance.reset', '重設為預設值')}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold"
                    >
                        {t('appearance.done', '完成')}
                    </button>
                </div>
            </div>
        </div>
    );

    return typeof document !== 'undefined' && document.body ? createPortal(content, document.body) : content;
}
