/**
 * QuickHelpModal.jsx
 * Built-in searchable offline Quick Help Center (opened from "?" in the top header).
 */
import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, Search, X, Keyboard } from 'lucide-react';
import { useI18n } from '../../i18n';

const HELP_GUIDES = [
    {
        id: 'undo',
        category: '規劃與捷徑',
        title: '行程排序與刪除 Undo / Redo（快捷鍵）',
        body: '調整景點順序或移除景點後，可按 Ctrl+Z (macOS 為 Cmd+Z) 復原，按 Ctrl+Shift+Z 重做，所有復原皆以 IndexedDB 為準確保資料一致。',
    },
    {
        id: 'map',
        category: '地圖與戶外',
        title: '3D 地形、周邊探索與 GPX 海拔剖面',
        body: '地圖上方工具列可一鍵切換 3D 地形、聚合標記、全行程總覽與 Overpass 周邊景點/美食/超商探索（點擊圖標即可加入當日行程）。點擊「GPX 剖面」可載入戶外軌跡並掛載實錄 GPX 對比距離與總爬升。',
    },
    {
        id: 'transit',
        category: '交通與導航',
        title: '大眾運輸 (Transitous)、7 款導航 App 與公路旅行模式',
        body: '每日時間軸支援透過免費 Transitous 查詢轉乘路線（無資料時自動降級 Google Maps）；每個景點可開啟 7 款導航 App；開啟「公路旅行」開關可設定每日行車時段並自動計算 ETA 與超時警示。',
    },
    {
        id: 'booking',
        category: '預訂與財務',
        title: '憑證匯入審核流、連動費用與 BYOK AI 收據掃描',
        body: '上傳 EML / PDF / PKPass 後會先進入審核視窗確認金額並可同步建立連動消費。財務中心支援多人共同墊付、結算歷史日誌，並可貼上自備 Gemini/OpenAI Key（僅存 sessionStorage）拍收據自動填表。',
    },
    {
        id: 'offline',
        category: '離線與協作',
        title: '手動離線模式、細粒度公開分享與旅伴共筆',
        body: '頂部列可隨時切換手動離線模式；分享按鈕旁的設定圖示可獨立勾選要公開的區塊（未勾選資料不會寫入 KV）；行程卡片內的「旅伴共筆」支援共用筆記、連結、投票與 What\'s Next。',
    },
    {
        id: 'sync',
        category: '同步與安全',
        title: 'Google Drive 完整備份與 Cloudflare Worker 子金鑰',
        body: 'Google Drive 備份涵蓋完整 IndexedDB v3 旅程與設定；Cloudflare Worker 支援限權子金鑰 (ltp_sk_...)、Append-Only Inbox 併發保護與 X-Idempotency-Key 離線重播去重。',
    },
];

export default function QuickHelpModal({ isOpen, onClose }) {
    const { t } = useI18n();
    const [query, setQuery] = useState('');

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return HELP_GUIDES;
        return HELP_GUIDES.filter(
            (g) => g.title.toLowerCase().includes(q) || g.body.toLowerCase().includes(q) || g.category.toLowerCase().includes(q)
        );
    }, [query]);

    if (!isOpen) return null;

    const content = (
        <div className="fixed inset-0 z-[85] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
            <div
                className="bg-white rounded-2xl max-w-lg w-full max-h-[85vh] flex flex-col shadow-2xl border border-slate-200 text-slate-800 overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                    <h3 className="font-extrabold text-sm flex items-center gap-2">
                        <HelpCircle className="w-4 h-4 text-indigo-600" />
                        <span>{t('help.title', 'Light Trip Plan 快速上手指南 (離線可用)')}</span>
                    </h3>
                    <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="p-3 border-b border-slate-100 bg-slate-50">
                    <div className="relative">
                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                            type="text"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t('help.searchPlaceholder', '搜尋指南（例：GPX、離線、分帳、收據、子金鑰）...')}
                            className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs focus:outline-none focus:border-indigo-500"
                        />
                    </div>
                </div>

                <div className="p-4 overflow-y-auto space-y-3 flex-1">
                    {filtered.length === 0 ? (
                        <p className="text-xs text-slate-400 text-center py-6">找不到符合「{query}」的說明項目</p>
                    ) : (
                        filtered.map((g) => (
                            <div key={g.id} className="p-3 rounded-xl border border-slate-200/80 bg-slate-50/50 space-y-1">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-extrabold text-xs text-slate-900">{g.title}</span>
                                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-bold shrink-0">
                                        {g.category}
                                    </span>
                                </div>
                                <p className="text-xs text-slate-600 leading-relaxed">{g.body}</p>
                            </div>
                        ))
                    )}

                    <div className="p-3 rounded-xl bg-slate-900 text-slate-200 text-[11px] space-y-1">
                        <div className="font-bold text-white flex items-center gap-1.5">
                            <Keyboard className="w-3.5 h-3.5 text-indigo-400" /> 常用快捷鍵
                        </div>
                        <div className="flex flex-wrap gap-3 text-slate-300">
                            <span><kbd className="px-1.5 py-0.5 bg-slate-700 rounded font-mono">Ctrl/Cmd + Z</kbd> 復原行程編輯</span>
                            <span><kbd className="px-1.5 py-0.5 bg-slate-700 rounded font-mono">Ctrl/Cmd + Shift + Z</kbd> 重做</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );

    return typeof document !== 'undefined' && document.body ? createPortal(content, document.body) : content;
}
