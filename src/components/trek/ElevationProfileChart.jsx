/**
 * ElevationProfileChart.jsx
 * Light Tours GPX 海拔剖面圖與「計畫 vs 實錄 GPX」對比元件
 */
import React, { useState, useRef } from 'react';
import {
    ResponsiveContainer,
    AreaChart,
    Area,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
} from 'recharts';
import { Mountain, Upload, X, ArrowUpRight, ArrowDownRight, Clock, Route } from 'lucide-react';
import { toast } from 'sonner';
import { parseGpxTrack, compareGpxTracks } from '../../services/import/geoImportService';
import { useI18n } from '../../i18n';

export default function ElevationProfileChart({ plannedTrack, onClearPlanned }) {
    const { t } = useI18n();
    const [recordedTrack, setRecordedTrack] = useState(null);
    const fileInputRef = useRef(null);

    if (!plannedTrack || !plannedTrack.sampledPoints || plannedTrack.sampledPoints.length === 0) {
        return null;
    }

    const diff = recordedTrack ? compareGpxTracks(plannedTrack, recordedTrack) : null;

    const handleUploadRecorded = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = parseGpxTrack(text);
            if (!parsed.points.length) {
                toast.error('實錄 GPX 檔案中找不到軌跡點 (<trkpt>)');
                return;
            }
            setRecordedTrack(parsed);
            toast.success(`已掛載實錄 GPX：${parsed.name || file.name}`);
        } catch (err) {
            toast.error(`解析實錄 GPX 失敗：${err.message}`);
        } finally {
            e.target.value = '';
        }
    };

    const chartData = plannedTrack.sampledPoints
        .filter((p) => p.ele !== null)
        .map((p) => ({
            distKm: p.distKm,
            ele: Math.round(p.ele),
        }));

    return (
        <div className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-extrabold text-slate-800">
                    <Mountain className="w-4 h-4 text-emerald-600" />
                    <span>{t('gpx.elevationTitle', 'GPX 海拔剖面與軌跡分析')}</span>
                    {plannedTrack.name && (
                        <span className="text-slate-500 font-medium truncate max-w-[160px]">· {plannedTrack.name}</span>
                    )}
                </div>
                <div className="flex items-center gap-1.5">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".gpx"
                        className="hidden"
                        onChange={handleUploadRecorded}
                    />
                    <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="px-2 py-1 rounded-md text-[11px] font-bold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 flex items-center gap-1"
                    >
                        <Upload className="w-3 h-3" />
                        <span>{t('gpx.compareRecorded', '掛載實錄 GPX 對比')}</span>
                    </button>
                    {onClearPlanned && (
                        <button
                            type="button"
                            onClick={onClearPlanned}
                            className="p-1 text-slate-400 hover:text-slate-700 rounded"
                            title="關閉剖面圖"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            </div>

            {/* 核心數據指標列 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                <div className="bg-slate-50 rounded-lg px-2.5 py-1.5 border border-slate-100">
                    <div className="text-slate-500 flex items-center gap-1"><Route className="w-3 h-3" />{t('gpx.distance', '總距離')}</div>
                    <div className="font-black text-slate-900 text-sm">{plannedTrack.totalDistanceKm} km</div>
                </div>
                <div className="bg-emerald-50/70 rounded-lg px-2.5 py-1.5 border border-emerald-100">
                    <div className="text-emerald-700 flex items-center gap-1"><ArrowUpRight className="w-3 h-3" />{t('gpx.ascent', '總爬升')}</div>
                    <div className="font-black text-emerald-900 text-sm">+{plannedTrack.totalAscentM} m</div>
                </div>
                <div className="bg-amber-50/70 rounded-lg px-2.5 py-1.5 border border-amber-100">
                    <div className="text-amber-700 flex items-center gap-1"><ArrowDownRight className="w-3 h-3" />{t('gpx.descent', '總下降')}</div>
                    <div className="font-black text-amber-900 text-sm">-{plannedTrack.totalDescentM} m</div>
                </div>
                <div className="bg-indigo-50/70 rounded-lg px-2.5 py-1.5 border border-indigo-100">
                    <div className="text-indigo-700 flex items-center gap-1"><Clock className="w-3 h-3" />{t('gpx.duration', '耗時 / 海拔範圍')}</div>
                    <div className="font-black text-indigo-900 text-xs mt-0.5">
                        {plannedTrack.durationMin != null ? `${plannedTrack.durationMin} 分` : '--'}
                        {plannedTrack.maxEleM != null ? ` (${plannedTrack.minEleM}~${plannedTrack.maxEleM}m)` : ''}
                    </div>
                </div>
            </div>

            {/* 計畫 vs 實錄差異徽章 */}
            {diff && recordedTrack && (
                <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-900 text-white rounded-lg px-3 py-2 text-[11px]">
                    <div className="font-bold">
                        實錄對比 ({recordedTrack.name || 'Recorded GPX'}):
                        <span className="ml-2 text-emerald-300">
                            距離 {diff.distanceDeltaKm >= 0 ? '+' : ''}{diff.distanceDeltaKm} km
                        </span>
                        <span className="ml-2 text-amber-300">
                            爬升 {diff.ascentDeltaM >= 0 ? '+' : ''}{diff.ascentDeltaM} m
                        </span>
                        {diff.durationDeltaMin != null && (
                            <span className="ml-2 text-sky-300">
                                耗時 {diff.durationDeltaMin >= 0 ? '+' : ''}{diff.durationDeltaMin} 分
                            </span>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => setRecordedTrack(null)}
                        className="text-slate-400 hover:text-white"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            )}

            {/* 海拔折線面積圖 */}
            {chartData.length > 1 ? (
                <div className="h-36 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData} margin={{ top: 6, right: 8, left: -16, bottom: 0 }}>
                            <defs>
                                <linearGradient id="eleFill" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.45} />
                                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                            <XAxis dataKey="distKm" tick={{ fontSize: 10 }} unit="km" />
                            <YAxis tick={{ fontSize: 10 }} unit="m" domain={['auto', 'auto']} />
                            <Tooltip
                                formatter={(val) => [`${val} m`, '海拔']}
                                labelFormatter={(label) => `里程 ${label} km`}
                            />
                            <Area
                                type="monotone"
                                dataKey="ele"
                                stroke="#059669"
                                strokeWidth={2}
                                fillOpacity={1}
                                fill="url(#eleFill)"
                            />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
            ) : (
                <div className="text-[11px] text-slate-500 text-center py-2">
                    此 GPX 軌跡未包含海拔 (`&lt;ele&gt;`) 數據，僅顯示距離統計。
                </div>
            )}
        </div>
    );
}
