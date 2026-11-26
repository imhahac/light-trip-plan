/**
 * CollabPanel.jsx
 * Lightweight Async Companion Collaboration (Serverless / IndexedDB + manual Worker sync).
 * Features 4 independent switches: Notes, Shared Links, Polls, and What's Next.
 * Intentionally avoids background polling to protect Cloudflare KV free tier limits.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { StickyNote, Link as LinkIcon, BarChart2, ListTodo, Plus, Trash2, ThumbsUp, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { collabItemRepo } from '../../services/db';
import { createStableId } from '../../utils/id';

const KINDS = [
    { key: 'note', label: '共用筆記', icon: StickyNote },
    { key: 'link', label: '推薦連結', icon: LinkIcon },
    { key: 'poll', label: '旅伴投票', icon: BarChart2 },
    { key: 'next', label: "What's Next", icon: ListTodo },
];

export default function CollabPanel({ tripId, onManualSync = null }) {
    const [items, setItems] = useState([]);
    const [enabledKinds, setEnabledKinds] = useState({ note: true, link: true, poll: true, next: true });
    const [activeKind, setActiveKind] = useState('note');
    const [title, setTitle] = useState('');
    const [detail, setDetail] = useState('');
    const [isSyncing, setIsSyncing] = useState(false);

    const loadItems = useCallback(async () => {
        if (!tripId) {
            setItems([]);
            return;
        }
        const list = await collabItemRepo.getByTrip(tripId);
        list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        setItems(list);
    }, [tripId]);

    useEffect(() => {
        loadItems();
    }, [loadItems]);

    const handleAdd = async (e) => {
        e.preventDefault();
        if (!tripId || !title.trim()) return;
        const entry = {
            id: createStableId('collab_'),
            tripId,
            kind: activeKind,
            title: title.trim(),
            detail: detail.trim(),
            votes: activeKind === 'poll' ? 1 : 0,
            done: false,
            createdAt: Date.now(),
        };
        await collabItemRepo.save(entry);
        setTitle('');
        setDetail('');
        await loadItems();
        toast.success('已新增旅伴共筆項目');
    };

    const handleVote = async (item) => {
        const updated = { ...item, votes: (item.votes || 0) + 1 };
        await collabItemRepo.save(updated);
        await loadItems();
    };

    const handleToggleDone = async (item) => {
        const updated = { ...item, done: !item.done };
        await collabItemRepo.save(updated);
        await loadItems();
    };

    const handleDelete = async (id) => {
        await collabItemRepo.delete(id);
        await loadItems();
    };

    const handleSyncClick = async () => {
        if (!onManualSync) return;
        setIsSyncing(true);
        try {
            await onManualSync();
            await loadItems();
        } finally {
            setIsSyncing(false);
        }
    };

    const visibleItems = items.filter((i) => enabledKinds[i.kind] && i.kind === activeKind);

    return (
        <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                    {KINDS.map((k) => {
                        const Icon = k.icon;
                        const isOn = enabledKinds[k.key];
                        return (
                            <button
                                key={k.key}
                                type="button"
                                onClick={() => setActiveKind(k.key)}
                                className={`px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1 transition ${
                                    activeKind === k.key
                                        ? 'bg-indigo-600 text-white'
                                        : isOn
                                            ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                                            : 'bg-slate-50 text-slate-400 line-through'
                                }`}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                <span>{k.label}</span>
                            </button>
                        );
                    })}
                </div>
                <div className="flex items-center gap-2">
                    <label className="text-[11px] text-slate-500 flex items-center gap-1 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={Boolean(enabledKinds[activeKind])}
                            onChange={(e) => setEnabledKinds((prev) => ({ ...prev, [activeKind]: e.target.checked }))}
                            className="rounded text-indigo-600"
                        />
                        <span>啟用此分頁</span>
                    </label>
                    {onManualSync && (
                        <button
                            type="button"
                            onClick={handleSyncClick}
                            disabled={isSyncing}
                            className="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-bold flex items-center gap-1"
                        >
                            <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
                            <span>手動同步</span>
                        </button>
                    )}
                </div>
            </div>

            {enabledKinds[activeKind] ? (
                <>
                    <form onSubmit={handleAdd} className="flex flex-wrap gap-2">
                        <input
                            type="text"
                            required
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={
                                activeKind === 'link'
                                    ? '標題（例：東京必吃拉麵清單）'
                                    : activeKind === 'poll'
                                        ? '投票選項（例：Day 3 改去鎌倉？）'
                                        : activeKind === 'next'
                                            ? '待決定事項（例：預約晴空塔門票）'
                                            : '輸入共用筆記標題...'
                            }
                            className="flex-1 min-w-[160px] border border-slate-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                        />
                        <input
                            type="text"
                            value={detail}
                            onChange={(e) => setDetail(e.target.value)}
                            placeholder={activeKind === 'link' ? 'https://...' : '補充說明（選填）'}
                            className="flex-1 min-w-[160px] border border-slate-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                        />
                        <button
                            type="submit"
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold flex items-center gap-1"
                        >
                            <Plus className="w-3.5 h-3.5" /> 新增
                        </button>
                    </form>

                    <div className="space-y-1.5">
                        {visibleItems.length === 0 ? (
                            <p className="text-xs text-slate-400 text-center py-4">尚無項目，新增一筆與旅伴共享吧！</p>
                        ) : (
                            visibleItems.map((item) => (
                                <div key={item.id} className="flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-50 border border-slate-200/70 text-xs">
                                    <div className="min-w-0 flex-1">
                                        <div className={`font-bold ${item.done ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                                            {item.title}
                                        </div>
                                        {item.detail && (
                                            item.kind === 'link' && /^https?:\/\//i.test(item.detail) ? (
                                                <a href={item.detail} target="_blank" rel="noopener noreferrer" className="text-[11px] text-indigo-600 hover:underline break-all">
                                                    {item.detail}
                                                </a>
                                            ) : (
                                                <div className="text-[11px] text-slate-500">{item.detail}</div>
                                            )
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        {item.kind === 'poll' && (
                                            <button
                                                type="button"
                                                onClick={() => handleVote(item)}
                                                className="px-2 py-1 rounded-lg bg-indigo-50 text-indigo-700 hover:bg-indigo-100 font-bold flex items-center gap-1"
                                            >
                                                <ThumbsUp className="w-3 h-3" /> {item.votes || 0}
                                            </button>
                                        )}
                                        {item.kind === 'next' && (
                                            <button
                                                type="button"
                                                onClick={() => handleToggleDone(item)}
                                                className="px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-bold"
                                            >
                                                {item.done ? '重開' : '完成'}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => handleDelete(item.id)}
                                            className="p-1 text-slate-400 hover:text-rose-600"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </>
            ) : (
                <p className="text-xs text-slate-400 text-center py-4">此協作區塊目前已關閉，勾選右上方「啟用此分頁」即可開啟。</p>
            )}
        </div>
    );
}
