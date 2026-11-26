/**
 * ReservationManager.jsx
 * 16 種通用預訂管理中心與雙軌票券匯入視窗：
 * - 支援 16 種標準預訂類型分類篩選
 * - 支援拖曳 / 點選上傳 PKPass、PDF、EML、HTML、TXT 自動結構化辨識
 * - 支援手動新增與編輯預訂
 * - 支援確認代碼一鍵複製與狀態管理
 */

import React, { useState, useEffect, useCallback } from 'react';
import { 
    Plus, 
    UploadCloud, 
    Copy, 
    Check, 
    Trash2, 
    Calendar, 
    Clock,
    FileText, 
    Loader2, 
    Plane, 
    Hotel, 
    Train, 
    Car, 
    Utensils, 
    Ticket, 
    Sparkles,
    Tag,
    RotateCcw
} from 'lucide-react';
import { toast } from 'sonner';
import { useTrek } from '../../contexts/TrekContext';
import { useUIContext } from '../../contexts/UIContext';
import { reservationRepo, expenseRepo, fileTrashRepo } from '../../services/db';
import { freezeExchangeRate } from '../../services/costs/currencyService';
import { RESERVATION_TYPES, RESERVATION_TYPE_CONFIG, RESERVATION_STATUS } from '../../constants/reservationTypes';
import { STORAGE_KEYS } from '../../constants/storageKeys';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { importBookingFile } from '../../services/import';

export default function ReservationManager({ unifiedReservations = null }) {
    const { activeTrip, reservations, refreshTrips } = useTrek();
    const { setActiveTab } = useUIContext();
    const [selectedCategory, setSelectedCategory] = useLocalStorage(STORAGE_KEYS.RESERVATION_CATEGORY, 'all');
    const [isUploading, setIsUploading] = useState(false);
    const [copiedId, setCopiedId] = useState(null);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    // Phase 2: 預訂匯入預覽審核草稿 + 軟刪除回收桶
    const [reviewDraft, setReviewDraft] = useState(null);
    const [createLinkedCost, setCreateLinkedCost] = useState(true);
    const [trashedItems, setTrashedItems] = useState([]);
    const [showTrash, setShowTrash] = useState(false);

    const loadTrash = useCallback(async () => {
        if (!activeTrip?.id) return;
        const items = await fileTrashRepo.getByTrip(activeTrip.id);
        setTrashedItems(items || []);
    }, [activeTrip?.id]);

    useEffect(() => {
        loadTrash();
    }, [loadTrash]);

    // 新增表單狀態
    const [formData, setFormData] = useState({
        type: 'flight',
        title: '',
        confirmationCode: '',
        status: 'confirmed',
        cost: '',
        currency: 'TWD',
        startDate: '',
        endDate: '',
        notes: '',
        // Flight
        flightNumber: '',
        airline: '',
        from: '',
        to: '',
        // Accommodation
        hotelName: '',
        checkInDate: '',
        checkOutDate: '',
        address: ''
    });

    if (!activeTrip) return null;

    // 優先使用整合全域票券憑證之預訂清單
    const activeReservationsList = unifiedReservations || reservations;

    // 篩選預訂項目
    const filteredReservations = activeReservationsList.filter(r => {
        if (selectedCategory === 'all') return true;
        return r.type === selectedCategory;
    });

    // ── 複製確認碼 ────────────────────────────────────────────────────────
    const handleCopyCode = (code, id) => {
        if (!code) return;
        navigator.clipboard.writeText(code);
        setCopiedId(id);
        toast.success(`已複製確認代碼：${code}`);
        setTimeout(() => setCopiedId(null), 2000);
    };

    // ── 檔案自動辨識匯入 ──────────────────────────────────────────────────
    const handleFileUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        toast.info(`正在解析 ${file.name}...`);

        try {
            const result = await importBookingFile(file);
            if (!result || !result.success) {
                toast.error(result?.error || '票券辨識失敗');
                return;
            }

            // 檢查是否已存在相同確認代碼或航班之預訂 (防重放/冪等性檢查)
            if (result.confirmationCode) {
                const existing = reservations.find(r => 
                    r.confirmationCode && r.confirmationCode.toUpperCase() === result.confirmationCode.toUpperCase()
                );
                if (existing) {
                    toast.warning(`此憑證確認代碼 (${result.confirmationCode}) 已存在於「${existing.title}」，已略過重複匯入`);
                    return;
                }
            }

            // 進入預覽審核步驟 (Review Step)，讓使用者確認欄位與金額後再存檔並選擇是否連動建立費用
            setReviewDraft({
                id: `res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                tripId: activeTrip.id,
                type: result.type || 'flight',
                status: 'confirmed',
                title: result.title || file.name,
                confirmationCode: result.confirmationCode || '',
                cost: Number(result.cost) || 0,
                currency: result.currency || activeTrip.baseCurrency || 'TWD',
                notes: result.notes || '',
                travellers: result.travellers || [],
                flightDetails: result.flightDetails || null,
                accommodationDetails: result.accommodationDetails || null,
                activityDetails: result.activityDetails || null,
                trainDetails: result.trainDetails || null,
                fileName: file.name,
            });
            setCreateLinkedCost(true);
            toast.info('已解析憑證！請於審核視窗確認內容後存檔');
        } catch (err) {
            toast.error(`匯入過程發生錯誤: ${err.message}`);
        } finally {
            setIsUploading(false);
            e.target.value = '';
        }
    };

    const createLinkedExpenseForReservation = async (resObj) => {
        const numericCost = Number(resObj.cost) || 0;
        if (numericCost <= 0) return;
        const baseCurrency = activeTrip.baseCurrency || 'TWD';
        const frozen = await freezeExchangeRate(numericCost, resObj.currency || baseCurrency, baseCurrency);
        const categoryMap = {
            flight: 'ticket',
            train: 'transport',
            bus: 'transport',
            car_rental: 'transport',
            accommodation: 'lodging',
            hotel: 'lodging',
            restaurant: 'food',
        };
        await expenseRepo.save({
            id: `exp_res_${resObj.id}`,
            tripId: activeTrip.id,
            reservationId: resObj.id,
            title: `預訂：${resObj.title}`,
            category: categoryMap[resObj.type] || 'ticket',
            amount: numericCost,
            currency: resObj.currency || baseCurrency,
            rateToTripBase: frozen.rateToBase || 1,
            baseCurrency,
            baseAmount: frozen.convertedAmount || numericCost,
            paidBy: '我',
            participants: ['我'],
            shares: { '我': numericCost },
            settled: true,
            date: (resObj.flightDetails?.departureTime || resObj.accommodationDetails?.checkInDate || new Date().toISOString()).slice(0, 10),
            createdAt: Date.now(),
        });
    };

    const handleConfirmReviewImport = async (e) => {
        e.preventDefault();
        if (!reviewDraft) return;
        const finalRes = {
            ...reviewDraft,
            cost: Number(reviewDraft.cost) || 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        await reservationRepo.save(finalRes);
        if (createLinkedCost && finalRes.cost > 0) {
            await createLinkedExpenseForReservation(finalRes);
        }
        await refreshTrips(activeTrip.id);
        toast.success(
            createLinkedCost && finalRes.cost > 0
                ? `✨ 已匯入預訂「${finalRes.title}」並同步建立連動費用`
                : `✨ 已匯入預訂「${finalRes.title}」`
        );
        setReviewDraft(null);
    };

    // ── 刪除預訂（軟刪除至回收桶，可還原） ─────────────────────────────────
    const handleDeleteReservation = async (res) => {
        if (res.source) {
            toast.info(`此項目由「${res.sourceLabel}」自動關聯，請於上方『票券憑證』工作台進行管理或修改。`);
            return;
        }
        if (confirm(`確定要將預訂項目「${res.title || '此項目'}」移至回收桶嗎？（可隨時還原）`)) {
            await fileTrashRepo.save({
                id: `trash_${res.id}`,
                tripId: activeTrip.id,
                kind: 'reservation',
                originalItem: res,
                title: res.title || '預訂項目',
                trashedAt: Date.now(),
            });
            await reservationRepo.delete(res.id);
            await loadTrash();
            await refreshTrips(activeTrip.id);
            toast.info('已移至回收桶，可隨時還原');
        }
    };

    const handleRestoreTrash = async (trashEntry) => {
        if (trashEntry?.originalItem) {
            await reservationRepo.save(trashEntry.originalItem);
        }
        await fileTrashRepo.delete(trashEntry.id);
        await loadTrash();
        await refreshTrips(activeTrip.id);
        toast.success(`已還原「${trashEntry.title}」`);
    };

    const handlePurgeTrash = async (trashId) => {
        await fileTrashRepo.delete(trashId);
        await loadTrash();
        toast.info('已永久清除');
    };

    // ── 手動新增預訂提交 ──────────────────────────────────────────────────
    const handleFormSubmit = async (e) => {
        e.preventDefault();
        const id = `res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        let flightDetails = null;
        let accommodationDetails = null;

        if (formData.type === 'flight') {
            flightDetails = {
                airline: formData.airline,
                flightNumber: formData.flightNumber,
                from: formData.from,
                to: formData.to,
                departureTime: formData.startDate
            };
        } else if (formData.type === 'accommodation') {
            accommodationDetails = {
                name: formData.hotelName || formData.title,
                checkInDate: formData.checkInDate || formData.startDate,
                checkOutDate: formData.checkOutDate || formData.endDate,
                address: formData.address
            };
        }

        const newRes = {
            id,
            tripId: activeTrip.id,
            type: formData.type,
            title: formData.title || (formData.type === 'flight' ? `${formData.flightNumber} (${formData.from} → ${formData.to})` : formData.hotelName) || '預訂項目',
            confirmationCode: formData.confirmationCode,
            status: formData.status,
            cost: Number(formData.cost) || 0,
            currency: formData.currency,
            notes: formData.notes,
            flightDetails,
            accommodationDetails,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await reservationRepo.save(newRes);
        await refreshTrips(activeTrip.id);
        toast.success(`已新增預訂：${newRes.title}`);
        setIsAddModalOpen(false);
    };

    return (
        <div className="space-y-4">
            {/* 1. 拖曳/上傳票券自動辨識橫幅 */}
            <div className="relative border-2 border-dashed border-indigo-200 hover:border-indigo-400 bg-indigo-50/50 hover:bg-indigo-50/80 rounded-2xl p-6 text-center transition-all cursor-pointer">
                <input
                    type="file"
                    accept=".pkpass,.pdf,.eml,.html,.txt"
                    onChange={handleFileUpload}
                    disabled={isUploading}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                />
                <div className="flex flex-col items-center justify-center pointer-events-none">
                    <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 mb-2">
                        {isUploading ? <Loader2 className="w-6 h-6 animate-spin" /> : <UploadCloud className="w-6 h-6" />}
                    </div>
                    <p className="text-sm font-bold text-slate-800">
                        {isUploading ? '正在結構化辨識票券...' : '點擊或拖曳票券至此自動辨識匯入'}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                        支援 Apple Wallet <code className="bg-white px-1.5 py-0.5 rounded border text-indigo-600 font-bold">.pkpass</code>、電子機票與飯店憑證 <code className="bg-white px-1.5 py-0.5 rounded border text-indigo-600 font-bold">.pdf</code>、確認郵件 <code className="bg-white px-1.5 py-0.5 rounded border text-indigo-600 font-bold">.eml / .html</code>
                    </p>
                </div>
            </div>

            {/* 2. 16 種分類篩選標籤 */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none max-w-full">
                    <button
                        onClick={() => setSelectedCategory('all')}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition whitespace-nowrap ${
                            selectedCategory === 'all'
                                ? 'bg-slate-900 text-white shadow-sm'
                                : 'bg-white text-slate-600 hover:bg-slate-100 border border-gray-200'
                        }`}
                    >
                        全部 ({activeReservationsList.length})
                    </button>
                    {Object.entries(RESERVATION_TYPE_CONFIG).map(([typeKey, cfg]) => {
                        const count = activeReservationsList.filter(r => r.type === typeKey).length;
                        return (
                            <button
                                key={typeKey}
                                onClick={() => setSelectedCategory(typeKey)}
                                className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 whitespace-nowrap ${
                                    selectedCategory === typeKey
                                        ? 'bg-indigo-600 text-white shadow-sm'
                                        : 'bg-white text-slate-600 hover:bg-slate-100 border border-gray-200'
                                }`}
                            >
                                <span>{cfg.emoji}</span>
                                <span>{cfg.shortLabel}</span>
                                {count > 0 && <span className="opacity-80 text-[10px]">({count})</span>}
                            </button>
                        );
                    })}
                </div>

                <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold shadow-sm transition flex items-center gap-1 shrink-0"
                >
                    <Plus className="w-3.5 h-3.5" />
                    <span>手動新增預訂</span>
                </button>
            </div>

            {/* 3. 預訂清單卡片 */}
            <div className="space-y-3">
                {filteredReservations.length === 0 ? (
                    <div className="bg-white rounded-xl p-10 text-center text-slate-400 border border-gray-200">
                        <Tag className="w-10 h-10 mx-auto mb-2 text-slate-300" />
                        <p className="text-sm font-semibold">此分類尚無預訂項目</p>
                        <p className="text-xs text-slate-400 mt-1">請上傳票券檔案或於頂部『票券憑證』新增機票、住宿與活動</p>
                    </div>
                ) : (
                    filteredReservations.map(res => {
                        const cfg = RESERVATION_TYPE_CONFIG[res.type] || RESERVATION_TYPE_CONFIG.other;
                        const statusObj = RESERVATION_STATUS[res.status?.toUpperCase()] || RESERVATION_STATUS.CONFIRMED;

                        return (
                            <div
                                key={res.id}
                                className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm hover:shadow-md transition flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
                            >
                                <div className="flex items-start gap-3.5 flex-1 min-w-0">
                                    <div className="w-11 h-11 rounded-xl bg-slate-100 flex items-center justify-center text-xl shrink-0">
                                        {cfg.emoji}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${cfg.badgeColor}`}>
                                                {cfg.label}
                                            </span>
                                            {res.sourceLabel && (
                                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                                                    🔗 {res.sourceLabel}
                                                </span>
                                            )}
                                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${statusObj.color}`}>
                                                {statusObj.label}
                                            </span>
                                            <h4 className="font-bold text-sm text-slate-900 truncate">
                                                {res.title}
                                            </h4>
                                        </div>

                                        {/* 細節資訊 */}
                                        <div className="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-3">
                                            {res.confirmationCode && (
                                                <button
                                                    onClick={() => handleCopyCode(res.confirmationCode, res.id)}
                                                    className="flex items-center gap-1 font-mono text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-2 py-0.5 rounded transition"
                                                    title="點擊複製確認碼"
                                                >
                                                    <span>代碼: {res.confirmationCode}</span>
                                                    {copiedId === res.id ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                                                </button>
                                            )}

                                            {res.flightDetails?.departureTime && (
                                                <span className="flex items-center gap-1 text-slate-600 font-medium bg-slate-50 px-2 py-0.5 rounded border border-slate-100">
                                                    <Clock className="w-3 h-3 text-indigo-500" />
                                                    出發: {res.flightDetails.departureTime}
                                                </span>
                                            )}

                                            {res.flightDetails?.arrivalTime && (
                                                <span className="flex items-center gap-1 text-slate-600 font-medium bg-slate-50 px-2 py-0.5 rounded border border-slate-100">
                                                    <Clock className="w-3 h-3 text-emerald-500" />
                                                    抵達: {res.flightDetails.arrivalTime}
                                                </span>
                                            )}

                                            {res.flightDetails?.airline && (
                                                <span className="text-slate-600 font-medium bg-indigo-50/70 text-indigo-800 px-2 py-0.5 rounded border border-indigo-100/60">
                                                    ✈️ {res.flightDetails.airline}
                                                </span>
                                            )}

                                            {res.accommodationDetails?.checkInDate && (
                                                <span className="flex items-center gap-1 text-slate-500">
                                                    <Calendar className="w-3 h-3" />
                                                    入住: {res.accommodationDetails.checkInDate} ~ {res.accommodationDetails.checkOutDate}
                                                </span>
                                            )}

                                            {res.notes && (
                                                <span className="text-slate-400 truncate max-w-[240px]">
                                                    {res.notes}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* 右側金額與操作 */}
                                <div className="flex items-center justify-between sm:justify-end w-full sm:w-auto gap-3 border-t sm:border-t-0 pt-2 sm:pt-0">
                                    <div className="text-left sm:text-right">
                                        {(res.currency || 'TWD') === 'TWD' ? (
                                            <div className="font-bold text-base text-slate-900">
                                                NT$ {Math.round(res.costTWD ?? res.cost ?? 0).toLocaleString()}
                                            </div>
                                        ) : (
                                            <div className="font-bold text-base text-slate-900">
                                                ${Math.round(res.cost ?? 0).toLocaleString()}
                                                <span className="text-xs font-normal text-slate-400 ml-1">{res.currency}</span>
                                            </div>
                                        )}
                                        {res.originalCurrency && res.originalCurrency !== 'TWD' && Number(res.originalCost) > 0 && (
                                            <div className="text-[11px] font-medium text-slate-400">
                                                {res.originalCurrency} {Math.round(res.originalCost).toLocaleString()}
                                            </div>
                                        )}
                                    </div>
                                    {Number(res.cost) > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => setActiveTab('costs')}
                                            className="px-2.5 py-1 text-xs font-bold text-indigo-700 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200/80 rounded-lg transition flex items-center gap-1 shadow-sm shrink-0"
                                            title="前往財務中心設定旅伴分帳"
                                        >
                                            <span>👥 分帳</span>
                                        </button>
                                    )}
                                    <button
                                        onClick={() => handleDeleteReservation(res)}
                                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                                        title={res.source ? '查看全域關聯提示' : '刪除預訂'}
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* 4. 手動新增預訂 Modal */}
            {isAddModalOpen && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl text-slate-800 animate-in fade-in zoom-in-95 duration-150 max-h-[90vh] overflow-y-auto">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="font-bold text-base flex items-center gap-2">
                                <Plus className="w-5 h-5 text-indigo-600" /> 手動新增行程預訂
                            </h3>
                            <button onClick={() => setIsAddModalOpen(false)} className="text-slate-400 hover:text-slate-600">&times;</button>
                        </div>

                        <form onSubmit={handleFormSubmit} className="space-y-3.5">
                            {/* 16 種型態切換 */}
                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1">預訂類型 (16 種)</label>
                                <select
                                    value={formData.type}
                                    onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                                >
                                    {Object.entries(RESERVATION_TYPE_CONFIG).map(([k, cfg]) => (
                                        <option key={k} value={k}>{cfg.emoji} {cfg.label}</option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-500 mb-1">名稱 / 描述</label>
                                <input
                                    type="text"
                                    required
                                    placeholder="例如：中華航空 CI100 或 東京新宿王子大飯店"
                                    value={formData.title}
                                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 mb-1">訂位代碼 (PNR)</label>
                                    <input
                                        type="text"
                                        placeholder="例如：WF89KJ"
                                        value={formData.confirmationCode}
                                        onChange={(e) => setFormData({ ...formData, confirmationCode: e.target.value })}
                                        className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:border-indigo-500"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 mb-1">狀態</label>
                                    <select
                                        value={formData.status}
                                        onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                                        className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                                    >
                                        <option value="confirmed">已確認</option>
                                        <option value="tentative">暫定</option>
                                        <option value="cancelled">已取消</option>
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 mb-1">金額</label>
                                    <input
                                        type="number"
                                        placeholder="0"
                                        value={formData.cost}
                                        onChange={(e) => setFormData({ ...formData, cost: e.target.value })}
                                        className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 mb-1">幣別</label>
                                    <select
                                        value={formData.currency}
                                        onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                                        className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                                    >
                                        <option value="TWD">TWD</option>
                                        <option value="JPY">JPY</option>
                                        <option value="USD">USD</option>
                                        <option value="EUR">EUR</option>
                                    </select>
                                </div>
                            </div>

                            <div className="flex justify-end gap-3 pt-3 border-t border-gray-100">
                                <button
                                    type="button"
                                    onClick={() => setIsAddModalOpen(false)}
                                    className="px-4 py-2 text-sm text-slate-500 hover:text-slate-700"
                                >
                                    取消
                                </button>
                                <button
                                    type="submit"
                                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-bold shadow-md transition"
                                >
                                    儲存預訂
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* 回收桶折疊區塊 (Trash & Restore) */}
            {trashedItems.length > 0 && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
                    <button
                        type="button"
                        onClick={() => setShowTrash((v) => !v)}
                        className="w-full flex items-center justify-between text-xs font-bold text-slate-600 hover:text-slate-900"
                    >
                        <span className="flex items-center gap-1.5">
                            <Trash2 className="w-3.5 h-3.5 text-slate-500" />
                            <span>預訂與檔案回收桶 ({trashedItems.length})</span>
                        </span>
                        <span className="text-[11px] text-indigo-600">{showTrash ? '收合' : '展開還原'}</span>
                    </button>
                    {showTrash && (
                        <div className="space-y-1.5 pt-1">
                            {trashedItems.map((item) => (
                                <div key={item.id} className="bg-white border border-slate-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2 text-xs">
                                    <span className="font-semibold text-slate-700 truncate">{item.title}</span>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <button
                                            type="button"
                                            onClick={() => handleRestoreTrash(item)}
                                            className="px-2 py-1 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100 font-bold flex items-center gap-1"
                                        >
                                            <RotateCcw className="w-3 h-3" /> 還原
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handlePurgeTrash(item.id)}
                                            className="px-2 py-1 rounded bg-rose-50 text-rose-700 hover:bg-rose-100 font-bold"
                                        >
                                            永久刪除
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* 預訂匯入預覽審核 Modal (Review Step + Linked Cost) */}
            {reviewDraft && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl text-slate-800 space-y-3">
                        <div className="flex items-center justify-between border-b border-gray-100 pb-2.5">
                            <h3 className="font-extrabold text-sm flex items-center gap-1.5">
                                <Sparkles className="w-4 h-4 text-indigo-600" />
                                <span>憑證匯入審核 (Review Step)</span>
                            </h3>
                            <button type="button" onClick={() => setReviewDraft(null)} className="text-slate-400 hover:text-slate-700">&times;</button>
                        </div>
                        <form onSubmit={handleConfirmReviewImport} className="space-y-3 text-xs">
                            <div>
                                <label className="block font-bold text-slate-600 mb-1">標題</label>
                                <input
                                    type="text"
                                    required
                                    value={reviewDraft.title}
                                    onChange={(e) => setReviewDraft({ ...reviewDraft, title: e.target.value })}
                                    className="w-full border border-gray-300 rounded-lg px-3 py-1.5"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-2.5">
                                <div>
                                    <label className="block font-bold text-slate-600 mb-1">確認代碼</label>
                                    <input
                                        type="text"
                                        value={reviewDraft.confirmationCode}
                                        onChange={(e) => setReviewDraft({ ...reviewDraft, confirmationCode: e.target.value })}
                                        className="w-full border border-gray-300 rounded-lg px-3 py-1.5 font-mono"
                                    />
                                </div>
                                <div>
                                    <label className="block font-bold text-slate-600 mb-1">類型</label>
                                    <select
                                        value={reviewDraft.type}
                                        onChange={(e) => setReviewDraft({ ...reviewDraft, type: e.target.value })}
                                        className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white"
                                    >
                                        {Object.entries(RESERVATION_TYPE_CONFIG).map(([key, cfg]) => (
                                            <option key={key} value={key}>{cfg.label}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2.5">
                                <div>
                                    <label className="block font-bold text-slate-600 mb-1">金額 (可填寫以連動記帳)</label>
                                    <input
                                        type="number"
                                        min="0"
                                        step="any"
                                        value={reviewDraft.cost}
                                        onChange={(e) => setReviewDraft({ ...reviewDraft, cost: e.target.value })}
                                        className="w-full border border-gray-300 rounded-lg px-3 py-1.5"
                                    />
                                </div>
                                <div>
                                    <label className="block font-bold text-slate-600 mb-1">幣別</label>
                                    <select
                                        value={reviewDraft.currency}
                                        onChange={(e) => setReviewDraft({ ...reviewDraft, currency: e.target.value })}
                                        className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white"
                                    >
                                        <option value="TWD">TWD</option>
                                        <option value="JPY">JPY</option>
                                        <option value="USD">USD</option>
                                        <option value="EUR">EUR</option>
                                        <option value="KRW">KRW</option>
                                    </select>
                                </div>
                            </div>
                            <label className="flex items-center gap-2 bg-indigo-50/70 border border-indigo-100 rounded-lg px-3 py-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={createLinkedCost}
                                    onChange={(e) => setCreateLinkedCost(e.target.checked)}
                                    className="rounded text-indigo-600"
                                />
                                <span className="font-bold text-indigo-900">金額 &gt; 0 時同步建立連動消費紀錄（免重複記帳）</span>
                            </label>
                            <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                                <button type="button" onClick={() => setReviewDraft(null)} className="px-3 py-1.5 text-slate-500">取消</button>
                                <button type="submit" className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold">確認並存入</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
