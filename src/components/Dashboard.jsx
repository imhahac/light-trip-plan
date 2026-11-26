/**
 * Dashboard.jsx ── 頂部統計卡片列
 *
 * 純展示元件，接收數字 props。
 *
 * Props:
 *   ticketCount      {number} 購入機票套數
 *   tripCount        {number} 配對出的趟次數
 *   hotelCount       {number} 住宿筆數
 *   totalPriceTWD    {number} 機票入帳總計 (TWD)
 *   totalHotelTWD    {number} 住宿總計 (TWD)
 *   futureCostTWD    {number} 未來待出行花費（機票）
 *   pastCostTWD      {number} 歷史已實現花費（機票）
 *   sunkCostTWD      {number} 未配對沉沒成本
 */
import React, { useState } from 'react';
import { ListFilter, Plane, Building2, SlidersHorizontal, ArrowLeft, ArrowRight } from 'lucide-react';
import { useFilterContext } from '../contexts/FilterContext';
import { useLocalStorage } from '../hooks/useLocalStorage';

const DEFAULT_WIDGETS = [
    { id: 'tickets', label: '購入機票總數', visible: true },
    { id: 'trips', label: '精算行程總額', visible: true },
    { id: 'budget', label: '旅費預算分析', visible: true },
];

export default function Dashboard() {
    const {
        safeTickets = [], trips = [], safeHotels = [], safeActivities = [],
        totalPriceTWD = 0, totalHotelTWD = 0, totalActivityTWD = 0,
        futureCostTWD = 0, pastCostTWD = 0, sunkCostTWD = 0, totalTripDays = 0,
    } = useFilterContext();

    const [widgets, setWidgets] = useLocalStorage('ltp_dashboard_widgets', DEFAULT_WIDGETS);
    const [isEditingWidgets, setIsEditingWidgets] = useState(false);

    const safeWidgets = Array.isArray(widgets) && widgets.length > 0 ? widgets : DEFAULT_WIDGETS;

    const handleToggleWidget = (id) => {
        setWidgets(safeWidgets.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w)));
    };

    const handleMoveWidget = (idx, dir) => {
        const target = idx + dir;
        if (target < 0 || target >= safeWidgets.length) return;
        const copy = [...safeWidgets];
        const [moved] = copy.splice(idx, 1);
        copy.splice(target, 0, moved);
        setWidgets(copy);
    };

    const ticketCount = safeTickets.length;
    const tripCount = trips.length;
    const hotelCount = safeHotels.length;
    const activityCount = safeActivities.length;
    const grandTotal = totalPriceTWD + totalHotelTWD + totalActivityTWD;
    const flightRatio = grandTotal > 0 ? (totalPriceTWD / grandTotal) * 100 : 0;
    const hotelRatio = grandTotal > 0 ? (totalHotelTWD / grandTotal) * 100 : 0;
    const activityRatio = grandTotal > 0 ? (totalActivityTWD / grandTotal) * 100 : 0;

    const renderWidget = (w) => {
        if (w.id === 'tickets') {
            return (
                <div key="tickets" className="bg-gradient-to-br from-indigo-500 to-indigo-600 p-5 rounded-2xl shadow-lg text-white relative overflow-hidden group">
                    <div className="relative z-10">
                        <p className="text-indigo-100 font-medium mb-1 text-sm">購入機票總數</p>
                        <p className="text-3xl font-extrabold">{ticketCount} 套</p>
                        <p className="text-[10px] text-indigo-200 mt-2 opacity-80 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                            <Plane className="w-3 h-3" /> 各項反向/單程機票總計
                        </p>
                    </div>
                    <ListFilter className="w-20 h-20 absolute -right-3 -bottom-3 text-white opacity-10 group-hover:scale-110 transition-transform" />
                </div>
            );
        }
        if (w.id === 'trips') {
            return (
                <div key="trips" className="bg-gradient-to-br from-emerald-500 to-teal-600 p-5 rounded-2xl shadow-lg text-white relative overflow-hidden group">
                    <div className="relative z-10">
                        <p className="text-emerald-50 font-medium mb-1 text-sm">精算行程總額</p>
                        <p className="text-3xl font-extrabold">{tripCount} 趟</p>
                        <div className="text-[10px] text-emerald-100 mt-2 flex items-center gap-3">
                            {hotelCount > 0 && <span className="flex items-center gap-1"><Building2 className="w-3 h-3" /> {hotelCount} 筆住宿</span>}
                            {activityCount > 0 && <span className="flex items-center gap-1">🎫 {activityCount} 項活動</span>}
                            {totalTripDays > 0 && <span className="flex items-center gap-1">🗓️ 共 {totalTripDays} 天</span>}
                        </div>
                    </div>
                    <Plane className="w-20 h-20 absolute -right-3 -bottom-3 text-white opacity-10 group-hover:scale-110 transition-transform" />
                </div>
            );
        }
        return (
            <div key="budget" className="col-span-2 bg-gradient-to-br from-slate-800 to-slate-900 p-5 rounded-2xl shadow-lg text-white relative overflow-hidden group">
                <div className="relative z-10">
                    <div className="flex items-baseline justify-between mb-2">
                        <p className="text-slate-300 font-medium text-sm">📊 旅費預算分析 (TWD)</p>
                        <p className="text-[10px] text-slate-400 font-bold bg-white/10 px-2 py-0.5 rounded-full">
                            日均：${totalTripDays > 0 ? Math.round(grandTotal / totalTripDays).toLocaleString() : 0} / 天
                        </p>
                    </div>
                    <div className="flex items-end gap-2 mb-4">
                        <p className="text-3xl font-extrabold">${grandTotal.toLocaleString()}</p>
                        <span className="text-xs text-slate-400 mb-1">機票 + 住宿</span>
                    </div>
                    <div className="mb-4">
                        <div className="flex justify-between text-[10px] mb-1.5 font-bold">
                            <span className="text-indigo-300">✈️ 機票 ({Math.round(flightRatio)}%)</span>
                            <span className="text-teal-300">🏨 住宿 ({Math.round(hotelRatio)}%)</span>
                            <span className="text-orange-300">🎫 活動 ({Math.round(activityRatio)}%)</span>
                        </div>
                        <div className="h-2.5 w-full bg-slate-700 rounded-full overflow-hidden flex shadow-inner">
                            <div className="h-full bg-indigo-500 transition-all duration-1000" style={{ width: `${flightRatio}%` }} />
                            <div className="h-full bg-teal-400 transition-all duration-1000" style={{ width: `${hotelRatio}%` }} />
                            <div className="h-full bg-orange-400 transition-all duration-1000" style={{ width: `${activityRatio}%` }} />
                        </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[10px]">
                        <div className="bg-white/5 border border-white/5 rounded-xl px-2 py-2">
                            <p className="text-slate-400 mb-0.5">🗓️ 待出行</p>
                            <p className="font-bold text-emerald-400 text-xs">${futureCostTWD.toLocaleString()}</p>
                        </div>
                        <div className="bg-white/5 border border-white/5 rounded-xl px-2 py-2">
                            <p className="text-slate-400 mb-0.5">✅ 已完成</p>
                            <p className="font-bold text-slate-200 text-xs">${pastCostTWD.toLocaleString()}</p>
                        </div>
                        <div className={`rounded-xl px-2 py-2 border ${sunkCostTWD > 0 ? 'bg-amber-500/10 border-amber-500/20' : 'bg-white/5 border-white/5'}`}>
                            <p className={`mb-0.5 ${sunkCostTWD > 0 ? 'text-amber-300' : 'text-slate-400'}`}>⚠️ 沉沒成本</p>
                            <p className={`font-bold text-xs ${sunkCostTWD > 0 ? 'text-amber-300' : 'text-slate-200'}`}>${sunkCostTWD.toLocaleString()}</p>
                        </div>
                    </div>
                </div>
                <div className="text-7xl font-black absolute -right-2 -bottom-8 text-white opacity-[0.03] select-none font-mono">$</div>
            </div>
        );
    };

    return (
        <div className="mb-8 space-y-2.5">
            <div className="flex items-center justify-end">
                <button
                    type="button"
                    onClick={() => setIsEditingWidgets((v) => !v)}
                    className="text-[11px] font-bold text-slate-500 hover:text-indigo-600 flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-slate-200/60 transition"
                >
                    <SlidersHorizontal className="w-3 h-3" />
                    <span>{isEditingWidgets ? '完成首頁卡片設定' : '自訂首頁 Widget'}</span>
                </button>
            </div>

            {isEditingWidgets && (
                <div className="bg-white border border-slate-200 rounded-xl p-2.5 flex flex-wrap items-center gap-2 text-xs shadow-xs">
                    {safeWidgets.map((w, idx) => (
                        <div key={w.id} className="flex items-center gap-1.5 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1">
                            <input
                                type="checkbox"
                                checked={w.visible}
                                onChange={() => handleToggleWidget(w.id)}
                                className="rounded text-indigo-600"
                            />
                            <span className="font-bold text-slate-700">{w.label}</span>
                            <button type="button" disabled={idx === 0} onClick={() => handleMoveWidget(idx, -1)} className="p-0.5 text-slate-400 hover:text-slate-800 disabled:opacity-30">
                                <ArrowLeft className="w-3 h-3" />
                            </button>
                            <button type="button" disabled={idx === safeWidgets.length - 1} onClick={() => handleMoveWidget(idx, 1)} className="p-0.5 text-slate-400 hover:text-slate-800 disabled:opacity-30">
                                <ArrowRight className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {safeWidgets.filter((w) => w.visible).map(renderWidget)}
            </div>
        </div>
    );
}

