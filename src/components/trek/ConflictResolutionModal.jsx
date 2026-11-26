/**
 * ConflictResolutionModal.jsx
 * Visual Keep-Mine / Keep-Theirs conflict resolution dialog for Offline Outbox sync.
 */
import React from 'react';
import { AlertTriangle, CloudDownload, UploadCloud, X } from 'lucide-react';

export default function ConflictResolutionModal({ conflict, onResolve, onClose, isResolving = false }) {
    if (!conflict) return null;
    const { item, remote } = conflict;

    const countKeys = (obj) => {
        if (!obj || typeof obj !== 'object') return '0 筆';
        const counts = ['tickets', 'hotels', 'activities', 'places', 'reservations', 'expenses']
            .filter((k) => Array.isArray(obj[k]) && obj[k].length > 0)
            .map((k) => `${k}: ${obj[k].length}`);
        return counts.length > 0 ? counts.join(' · ') : '單筆更新';
    };

    return (
        <div className="fixed inset-0 z-[90] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-lg w-full p-5 shadow-2xl border border-amber-200 space-y-4 text-slate-800">
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                    <h3 className="font-extrabold text-sm flex items-center gap-2 text-amber-800">
                        <AlertTriangle className="w-5 h-5 text-amber-500" />
                        <span>偵測到離線同步版本衝突</span>
                    </h3>
                    <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">
                    通道 <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono font-bold">{item.channel}</code> 在您離線期間已有較新的雲端版本（本機基準 v{item.baseRevision} → 雲端最新 v{remote?.revision}）。請選擇要保留哪一份變更：
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div className="p-3 rounded-xl bg-indigo-50/70 border border-indigo-200 space-y-1">
                        <div className="font-extrabold text-indigo-900">📱 我的離線變更 (Keep Mine)</div>
                        <div className="text-indigo-700">{item.label || '本機編輯'}</div>
                        <div className="text-[11px] text-slate-600">{countKeys(item.payload)}</div>
                        <div className="text-[10px] text-slate-400 font-mono">Key: {item.idempotencyKey?.slice(0, 14)}…</div>
                    </div>

                    <div className="p-3 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-1">
                        <div className="font-extrabold text-emerald-900">☁️ 雲端最新版本 (Keep Theirs)</div>
                        <div className="text-emerald-700">版本 v{remote?.revision}</div>
                        <div className="text-[11px] text-slate-600">{countKeys(remote?.data)}</div>
                        <div className="text-[10px] text-slate-400">{remote?.updatedAt ? new Date(remote.updatedAt).toLocaleString() : ''}</div>
                    </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-slate-100">
                    <button
                        type="button"
                        disabled={isResolving}
                        onClick={() => onResolve('keep-mine')}
                        className="flex-1 py-2 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                        <UploadCloud className="w-4 h-4" />
                        <span>保留我的 (覆蓋推送)</span>
                    </button>
                    <button
                        type="button"
                        disabled={isResolving}
                        onClick={() => onResolve('keep-theirs')}
                        className="flex-1 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
                    >
                        <CloudDownload className="w-4 h-4" />
                        <span>採用雲端 (捨棄此筆離線)</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
