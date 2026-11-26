/**
 * ShareButton.jsx ── 分享行程按鈕
 *
 * 支援將當前旅程透過 Cloudflare Worker 建立唯讀分享連結，
 * 或在未設定 Worker 時自動降級為系統原生分享 (Web Share API) 與剪貼簿文字摘要。
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Share2, Check, Loader2, SlidersHorizontal, X } from 'lucide-react';
import { toast } from 'sonner';
import { createShareSnapshot, buildFilteredShareSnapshot } from '../services/shareService';
import { packingRepo, expenseRepo } from '../services/db';
import { useFilterContext } from '../contexts/FilterContext';
import { useTicketDataContext } from '../contexts/DataContext';
import { useTrek } from '../contexts/TrekContext';

const PROXY_BASE = (import.meta.env.VITE_FLIGHT_PROXY_URL || 'https://flight-api-proxy.imhahac.workers.dev').replace(/\/+$/, '');

export default function ShareButton({ variant = 'default', className = '' }) {
    const [isSharing, setIsSharing] = useState(false);
    const [copied, setCopied] = useState(false);
    const [showOptions, setShowOptions] = useState(false);
    const [shareScopes, setShareScopes] = useState({
        includeMap: true,
        includeBookings: true,
        includePacking: false,
        includeCosts: false,
    });
    const { filteredItinerary, safeHotels, safeActivities } = useFilterContext();
    const { tripLabels } = useTicketDataContext();
    const { activeTrip, dayPlans, reservations } = useTrek();

    const handleShare = async () => {
        setIsSharing(true);
        try {
            // 1. 若有配置 Cloudflare Worker，走雲端快照連結分享
            if (PROXY_BASE) {
                let tripToShare = activeTrip;
                if (!tripToShare && filteredItinerary?.length > 0) {
                    const firstItin = filteredItinerary[0];
                    const seg = firstItin.segments?.[0];
                    tripToShare = {
                        id: `trip_shared_${Date.now()}`,
                        title: firstItin.customLabel || (seg?.airline && seg?.flightNo ? `${seg.airline} ${seg.flightNo} 旅程` : '精彩旅程'),
                        startDate: firstItin.tripStartAt ? firstItin.tripStartAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
                        endDate: firstItin.tripEndAt ? firstItin.tripEndAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
                        baseCurrency: 'TWD',
                        budget: firstItin.totalCostTWD || 0,
                        status: 'planning',
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    };
                }

                const [packingItems, expenses] = await Promise.all([
                    shareScopes.includePacking && tripToShare?.id ? packingRepo.getByTrip(tripToShare.id).catch(() => []) : Promise.resolve([]),
                    shareScopes.includeCosts && tripToShare?.id ? expenseRepo.getByTrip(tripToShare.id).catch(() => []) : Promise.resolve([]),
                ]);

                const snapshot = buildFilteredShareSnapshot(
                    {
                        trip: tripToShare,
                        itinerary: filteredItinerary,
                        tripLabels,
                        hotels: safeHotels,
                        activities: safeActivities,
                        dayPlans: dayPlans || [],
                        reservations: reservations || [],
                        packingItems,
                        expenses,
                        createdAt: new Date().toISOString(),
                    },
                    shareScopes
                );

                const id = await createShareSnapshot(snapshot);
                setShowOptions(false);
                const shareUrl = `${window.location.origin}${window.location.pathname}?view=${id}`;

                await navigator.clipboard.writeText(shareUrl);
                setCopied(true);
                toast.success('分享連結已複製到剪貼簿！', {
                    description: '連結有效期為 30 天，可傳送給好友唯讀檢視。',
                });
                setTimeout(() => setCopied(false), 3000);
                return;
            }

            // 2. 備援方案 A：原生 Web Share API（手機或 macOS 支援原生分享）
            const tripTitle = activeTrip?.title || '精彩旅程';
            const tripDates = activeTrip?.startDate && activeTrip?.endDate 
                ? `${activeTrip.startDate} ~ ${activeTrip.endDate}`
                : '';
            const shareText = `🎒 【${tripTitle}】\n${tripDates ? `📅 日期：${tripDates}\n` : ''}🔗 行程連結：${window.location.href}`;

            if (navigator.share) {
                try {
                    await navigator.share({
                        title: tripTitle,
                        text: shareText,
                        url: window.location.href
                    });
                    setCopied(true);
                    toast.success('已開啟分享選單！');
                    setTimeout(() => setCopied(false), 3000);
                    return;
                } catch (shareErr) {
                    if (shareErr.name === 'AbortError') return; // 使用者主動取消
                }
            }

            // 3. 備援方案 B：直接複製行程純文字摘要至剪貼簿
            await navigator.clipboard.writeText(shareText);
            setCopied(true);
            toast.success('行程資訊已複製到剪貼簿！', {
                description: '可直接貼上傳送給同行旅伴。'
            });
            setTimeout(() => setCopied(false), 3000);
        } catch (err) {
            toast.error('分享失敗', { description: err.message });
        } finally {
            setIsSharing(false);
        }
    };

    // 樣式判斷：Header 專用深色風格 vs 預設淺色風格
    const isHeader = variant === 'header';

    const headerClasses = isSharing
        ? 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20'
        : copied
            ? 'bg-emerald-500/25 text-emerald-200 border-emerald-400/40'
            : 'bg-indigo-500/25 hover:bg-indigo-500/40 text-indigo-100 hover:text-white border-indigo-400/30 hover:border-indigo-300/50 shadow-xs';

    const defaultClasses = isSharing
        ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
        : copied
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100';

    return (
        <div className="relative inline-flex items-center gap-1">
            <button
                onClick={handleShare}
                disabled={isSharing}
                title="分享此行程連結給好友"
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-bold rounded-lg border transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${
                    isHeader ? headerClasses : defaultClasses
                } ${className}`}
            >
                {isSharing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : copied ? (
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                    <Share2 className="w-3.5 h-3.5" />
                )}
                <span>{copied ? '已複製！' : isSharing ? '建立中...' : '分享行程'}</span>
            </button>
            <button
                type="button"
                onClick={() => setShowOptions((v) => !v)}
                title="設定公開分享包含區塊（地圖/預訂/行李/費用）"
                className={`p-1 rounded-lg border text-xs transition ${isHeader ? headerClasses : defaultClasses}`}
            >
                <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>

            {showOptions && (typeof document !== 'undefined' && document.body
                ? createPortal(
                    <div
                        className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-xs flex items-center justify-center p-4"
                        onClick={() => setShowOptions(false)}
                    >
                        <div
                            className="w-full max-w-xs bg-white border border-slate-200 rounded-2xl shadow-2xl p-4 text-xs text-slate-700 space-y-3"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                                <span className="font-extrabold text-sm text-slate-900">公開分享範圍設定</span>
                                <button
                                    type="button"
                                    onClick={() => setShowOptions(false)}
                                    className="text-slate-400 hover:text-slate-700 p-0.5"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <p className="text-[11px] text-slate-500 leading-relaxed">
                                未勾選的區塊將不會傳送至公開分享連結，確保隱私安全。
                            </p>
                            <div className="space-y-2">
                                <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 hover:bg-slate-100 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={shareScopes.includeMap}
                                        onChange={(e) => setShareScopes((p) => ({ ...p, includeMap: e.target.checked }))}
                                        className="rounded text-indigo-600"
                                    />
                                    <span className="font-semibold text-slate-800">🗺️ 每日行程與地圖</span>
                                </label>
                                <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 hover:bg-slate-100 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={shareScopes.includeBookings}
                                        onChange={(e) => setShareScopes((p) => ({ ...p, includeBookings: e.target.checked }))}
                                        className="rounded text-indigo-600"
                                    />
                                    <span className="font-semibold text-slate-800">✈️ 預訂憑證 (機票/飯店)</span>
                                </label>
                                <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 hover:bg-slate-100 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={shareScopes.includePacking}
                                        onChange={(e) => setShareScopes((p) => ({ ...p, includePacking: e.target.checked }))}
                                        className="rounded text-indigo-600"
                                    />
                                    <span className="font-semibold text-slate-800">🎒 行李清單</span>
                                </label>
                                <label className="flex items-center gap-2.5 p-2 rounded-xl bg-slate-50 hover:bg-slate-100 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={shareScopes.includeCosts}
                                        onChange={(e) => setShareScopes((p) => ({ ...p, includeCosts: e.target.checked }))}
                                        className="rounded text-indigo-600"
                                    />
                                    <span className="font-semibold text-slate-800">💰 費用與預算總覽</span>
                                </label>
                            </div>
                            <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                                <button
                                    type="button"
                                    onClick={() => setShowOptions(false)}
                                    className="px-3 py-2 rounded-xl text-slate-500 hover:bg-slate-100 font-bold"
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    onClick={handleShare}
                                    disabled={isSharing}
                                    className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold disabled:opacity-50"
                                >
                                    {isSharing ? '建立中...' : '建立並複製分享連結'}
                                </button>
                            </div>
                        </div>
                    </div>,
                    document.body
                )
                : null)}
        </div>
    );
}

