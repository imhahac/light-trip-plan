/**
 * ExportImportModal.jsx
 * 外部資料匯入匯出、旅程日期平移與手冊中心：
 * 1. JSON 整包匯入：一次匯入整趟旅程（多日景點、機票、住宿、活動、預訂、費用、行李、待辦）或舊版備份 JSON
 * 2. 景點匯入：GPX / KML / KMZ 檔案與 Google Maps / Naver Maps 連結解析
 * 3. 資料匯出：完整 JSON 備份、RFC 5545 .ics、GPX 1.1 .gpx 與除錯診斷包
 * 4. 旅程日期平移 (Move Trip Dates)：一鍵調整出發日期，級聯平移所有日程與預訂
 * 5. 專業旅遊手冊：A4 向量列印與 PDF 匯出
 */

import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
    X,
    Upload,
    Download,
    Calendar,
    BookOpen,
    Check,
    ArrowRight,
    Loader2,
    Share2,
    Compass,
    Bug,
    FileJson,
    Copy,
    Key,
    Trash2,
    Plus,
    RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTrek } from '../../contexts/TrekContext';
import { parseGeoFile, parseMapLinks } from '../../services/import/geoImportService';
import {
    parseUnifiedJsonInput,
    executeUnifiedJsonImport,
    buildFullJsonExport,
    getJsonImportTemplate,
} from '../../services/import/jsonTripImportService';
import {
    getStoredApiSyncConfig,
    saveApiSyncConfig,
    getLastSyncedRevision,
    setLastSyncedRevision,
    pullFromIngestApi,
    pushToIngestApi,
    listSubKeys,
    createSubKey,
    revokeSubKey,
    buildIngestCurlExamples,
} from '../../services/api/ingestApiService';
import { generateTripIcs, downloadIcsFile } from '../../services/export/icsExportService';
import { generateTripGpx, downloadGpxFile } from '../../services/export/gpxExportService';
import { shiftTripDates, calculateDayDifference } from '../../services/trips/tripShiftService';
import { placeItemRepo, packingRepo, expenseRepo, todoRepo } from '../../services/db';
import { downloadDiagnosticDump } from '../../utils/diagnosticDump';
import {
    useTicketDataContext,
    useHotelDataContext,
    useActivityDataContext,
    useOverrideDataContext,
} from '../../contexts/DataContext';
import { getUnifiedReservations } from '../../services/reservations/unifiedReservationService';
import { assembleTripDays } from '../../services/trips/tripExportAssembler';
import TripBrochureModal from './TripBrochureModal';

function triggerJsonDownload(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
        href: url,
        download: filename,
    }).click();
    URL.revokeObjectURL(url);
}

export default function ExportImportModal({ isOpen, onClose }) {
    const { activeTrip, dayPlans, reservations, refreshTrips } = useTrek();

    // 整合機票、飯店、活動與覆寫資料
    const ticketContext = useTicketDataContext?.() || {};
    const hotelContext = useHotelDataContext?.() || {};
    const activityContext = useActivityDataContext?.() || {};
    const overrideContext = useOverrideDataContext?.() || {};

    const tickets = ticketContext.tickets || [];
    const tripLabels = ticketContext.tripLabels || {};
    const tripBudgets = ticketContext.tripBudgets || {};
    const rawHotels = hotelContext.rawHotels || [];
    const activities = activityContext.activities || [];
    const tripOverrides = overrideContext.tripOverrides || {};

    const unifiedReservations = React.useMemo(() => {
        if (!activeTrip) return [];
        return getUnifiedReservations(activeTrip, reservations, tickets, rawHotels, activities);
    }, [activeTrip, reservations, tickets, rawHotels, activities]);

    const [activeTab, setActiveTab] = useState('json_import'); // 'json_import' | 'import' | 'export' | 'shift' | 'brochure'
    const [isBrochureOpen, setIsBrochureOpen] = useState(false);
    const [tripPlaces, setTripPlaces] = useState([]);

    // 計算可用天數清單 (確保無 dayPlan 紀錄時仍能精準選取 Day 1 ~ Day N)
    const tripDays = React.useMemo(() => {
        if (!activeTrip) return [];
        return assembleTripDays({ trip: activeTrip, dayPlans, places: [] });
    }, [activeTrip, dayPlans]);

    // ── JSON 一次性匯入狀態 ─────────────────────────────────────────────────
    const [jsonText, setJsonText] = useState('');
    const [parsedJson, setParsedJson] = useState(null);
    const [jsonError, setJsonError] = useState('');
    const [importMode, setImportMode] = useState('merge'); // 'merge' | 'replace'
    const [tripTarget, setTripTarget] = useState('current'); // 'current' | 'new'
    const [isImportingJson, setIsImportingJson] = useState(false);

    // ── 景點匯入狀態 ────────────────────────────────────────────────────────
    const [pastedLinks, setPastedLinks] = useState('');
    const [parsedPlaces, setParsedPlaces] = useState([]);
    const [selectedTargetDay, setSelectedTargetDay] = useState(0); // 0 = 第一天
    const [isImporting, setIsImporting] = useState(false);
    const [isParsingLinks, setIsParsingLinks] = useState(false);

    // ── 日期平移狀態 ────────────────────────────────────────────────────────
    const [newStartDate, setNewStartDate] = useState(activeTrip?.startDate || '');
    const [isShifting, setIsShifting] = useState(false);

    // ── 手冊附加資料狀態 ───────────────────────────────────────────────────
    const [packingItems, setPackingItems] = useState([]);
    const [expenses, setExpenses] = useState([]);

    // ── 外部寫入 API 同步配置狀態 ──────────────────────────────────────────
    const [apiConfig, setApiConfig] = useState(() => getStoredApiSyncConfig());
    const [isSyncingApi, setIsSyncingApi] = useState(false);

    // ── 子金鑰管理 (Sub-Key Management) 狀態（Master Token 僅暫存於記憶體，絕不寫入 localStorage）──
    const [masterAdminToken, setMasterAdminToken] = useState('');
    const [subKeys, setSubKeys] = useState([]);
    const [isLoadingSubKeys, setIsLoadingSubKeys] = useState(false);
    const [newKeyLabel, setNewKeyLabel] = useState('');
    const [newKeyPermMode, setNewKeyPermMode] = useState('read_write'); // 'read_write' | 'write_only' | 'read_only'
    const [newKeyChannels, setNewKeyChannels] = useState('*');
    const [newKeyExpiresDays, setNewKeyExpiresDays] = useState(0); // 0 = 永久
    const [newlyIssuedKey, setNewlyIssuedKey] = useState(null);

    // 關閉視窗時強制清空記憶體中的 Master Admin Token 與一次性明文子金鑰
    useEffect(() => {
        if (!isOpen) {
            setMasterAdminToken('');
            setNewlyIssuedKey(null);
        }
    }, [isOpen]);

    useEffect(() => {
        setNewStartDate(activeTrip?.startDate || '');
        if (!activeTrip) {
            setTripTarget('new');
        }
    }, [activeTrip]);

    if (!isOpen) return null;

    // ── JSON 一次性匯入處理 ────────────────────────────────────────────────
    const parseJsonSource = (rawText) => {
        try {
            const parsed = parseUnifiedJsonInput(rawText, { activeTrip });
            setParsedJson(parsed);
            setJsonError('');
            if (!activeTrip) {
                setTripTarget('new');
            }
            toast.success(`成功解析 JSON！共 ${parsed.summary.totalItems} 筆項目，確認後即可一次性匯入`);
        } catch (err) {
            setParsedJson(null);
            setJsonError(err.message);
            toast.error(`JSON 解析失敗：${err.message}`);
        }
    };

    const handleJsonFileUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            setJsonText(text);
            parseJsonSource(text);
        } catch (err) {
            setJsonError(err.message);
            toast.error(`讀取檔案失敗：${err.message}`);
        } finally {
            e.target.value = '';
        }
    };

    const handleConfirmJsonImport = async () => {
        if (!parsedJson) return;
        setIsImportingJson(true);
        try {
            const result = await executeUnifiedJsonImport({
                parsed: parsedJson,
                activeTrip,
                mode: importMode,
                tripTarget: activeTrip ? tripTarget : 'new',
                dataSetters: {
                    setTickets: ticketContext.setTickets,
                    setTripLabels: ticketContext.setTripLabels,
                    setTripBudgets: ticketContext.setTripBudgets,
                    setHotels: hotelContext.setHotels,
                    setActivities: activityContext.setActivities,
                    setOverrides: overrideContext.setOverrides,
                },
            });

            await refreshTrips(result.targetTripId || activeTrip?.id || null);

            const s = result.summary;
            const details = [
                s.placesCount ? `${s.placesCount} 景點` : null,
                s.ticketsCount ? `${s.ticketsCount} 機票` : null,
                s.hotelsCount ? `${s.hotelsCount} 住宿` : null,
                s.activitiesCount ? `${s.activitiesCount} 活動` : null,
                s.reservationsCount ? `${s.reservationsCount} 預訂` : null,
                s.expensesCount ? `${s.expensesCount} 費用` : null,
                s.packingCount ? `${s.packingCount} 行李` : null,
                s.todosCount ? `${s.todosCount} 待辦` : null,
            ].filter(Boolean).join('、');

            toast.success(`🎉 一次性匯入完成！${details ? `（${details}）` : ''}`);
            setParsedJson(null);
            setJsonText('');
            setJsonError('');
            onClose();
        } catch (err) {
            toast.error(`匯入失敗：${err.message}`);
        } finally {
            setIsImportingJson(false);
        }
    };

    const handleCopyJsonTemplate = async () => {
        const tpl = JSON.stringify(getJsonImportTemplate(activeTrip), null, 2);
        try {
            await navigator.clipboard.writeText(tpl);
            toast.success('已複製標準 JSON 匯入範本到剪貼簿！');
        } catch {
            setJsonText(tpl);
            toast.info('已將範本填入下方文字框');
        }
    };

    const handleDownloadJsonTemplate = () => {
        const tpl = getJsonImportTemplate(activeTrip);
        triggerJsonDownload('trip-import-template.json', tpl);
        toast.success('已下載 JSON 匯入範本！');
    };

    // ── 完整 JSON 備份匯出 ─────────────────────────────────────────────────
    const handleExportFullJson = async () => {
        try {
            const [places, pItems, expItems, todos] = activeTrip
                ? await Promise.all([
                    placeItemRepo.getByTrip(activeTrip.id).catch(() => []),
                    packingRepo.getByTrip(activeTrip.id).catch(() => []),
                    expenseRepo.getByTrip(activeTrip.id).catch(() => []),
                    todoRepo.getByTrip(activeTrip.id).catch(() => []),
                ])
                : [[], [], [], []];

            const payload = buildFullJsonExport({
                trip: activeTrip,
                dayPlans,
                places,
                reservations,
                expenses: expItems,
                packingItems: pItems,
                todos,
                tickets,
                hotels: rawHotels,
                activities,
                tripLabels,
                tripBudgets,
                tripOverrides,
            });
            const dateStamp = new Date().toISOString().split('T')[0];
            const safeTitle = (activeTrip?.title || 'travel').replace(/[^\w\u4e00-\u9fa5-]+/g, '_');
            triggerJsonDownload(`${safeTitle}_backup_${dateStamp}.json`, payload);
            toast.success('已匯出完整旅程與票券 JSON 備份檔！');
        } catch (err) {
            toast.error(`匯出 JSON 失敗：${err.message}`);
        }
    };

    // 1. 處理檔案匯入 (GPX / KML / KMZ)
    const handleFileUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            const places = await parseGeoFile(file);
            if (places.length === 0) {
                toast.warning('檔案中未找到有效的航點或地標');
                return;
            }
            setParsedPlaces(places);
            toast.success(`成功解析 ${places.length} 個地點！請確認後匯入行程`);
        } catch (err) {
            toast.error(`解析失敗: ${err.message}`);
        } finally {
            e.target.value = '';
        }
    };

    // 2. 處理文字貼上連結解析 (Google / Naver / 座標 / 純景點地名)
    const handleParseLinks = async () => {
        if (!pastedLinks.trim()) return;
        setIsParsingLinks(true);
        try {
            const places = await parseMapLinks(pastedLinks);
            if (places.length === 0) {
                toast.warning('未能識別出有效的地圖連結、景點名稱或座標');
                return;
            }
            setParsedPlaces(places);
            toast.success(`🎉 成功解析 ${places.length} 個地標！請確認後匯入行程`);
        } catch (err) {
            toast.error(`解析失敗: ${err.message}`);
        } finally {
            setIsParsingLinks(false);
        }
    };

    // 3. 確認匯入至指定日程
    const handleConfirmImport = async () => {
        if (parsedPlaces.length === 0 || !activeTrip) return;
        setIsImporting(true);

        try {
            const targetDayIndex = selectedTargetDay;
            const existingPlaces = await placeItemRepo.getByTrip(activeTrip.id).catch(() => []);
            const dayPlacesCount = existingPlaces.filter((p) => (p.dayIndex ?? 0) === targetDayIndex).length;

            const newPlaces = parsedPlaces.map((p, idx) => ({
                id: `place_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
                tripId: activeTrip.id,
                dayIndex: targetDayIndex,
                name: p.name,
                lat: p.lat,
                lng: p.lng,
                address: p.address || p.desc || p.originalUrl || '',
                notes: p.notes || `從外部匯入 (${p.source || '外部'})`,
                orderIndex: dayPlacesCount + idx,
                createdAt: Date.now(),
            }));

            await placeItemRepo.saveBatch(newPlaces);

            toast.success(`✨ 已將 ${newPlaces.length} 個景點成功匯入至 Day ${targetDayIndex + 1}！`);
            setParsedPlaces([]);
            setPastedLinks('');
            await refreshTrips(activeTrip.id);
            onClose();
        } catch (err) {
            toast.error(`匯入失敗: ${err.message}`);
        } finally {
            setIsImporting(false);
        }
    };

    // 4. 匯出 ICS 行事曆
    const handleExportIcs = async () => {
        if (!activeTrip) return;
        try {
            const [todos, places] = await Promise.all([
                todoRepo.getByTrip(activeTrip.id).catch(() => []),
                placeItemRepo.getByTrip(activeTrip.id).catch(() => []),
            ]);
            const assembledDays = assembleTripDays({ trip: activeTrip, dayPlans, places });
            const icsContent = generateTripIcs(activeTrip, assembledDays, unifiedReservations, todos);
            const fileName = `${activeTrip.title || 'trip'}_calendar.ics`;
            downloadIcsFile(fileName, icsContent);
            toast.success('已匯出 iCalendar 行事曆檔案 (.ics)！');
        } catch (err) {
            toast.error(`匯出 ICS 失敗: ${err.message}`);
        }
    };

    // 5. 匯出 GPX 航跡
    const handleExportGpx = async () => {
        if (!activeTrip) return;
        try {
            const places = await placeItemRepo.getByTrip(activeTrip.id).catch(() => []);
            const assembledDays = assembleTripDays({ trip: activeTrip, dayPlans, places });
            const gpxContent = generateTripGpx(activeTrip, assembledDays);
            const fileName = `${activeTrip.title || 'trip'}_route.gpx`;
            downloadGpxFile(fileName, gpxContent);
            toast.success('已匯出 GPX 航跡檔案 (.gpx)！');
        } catch (err) {
            toast.error(`匯出 GPX 失敗: ${err.message}`);
        }
    };

    // 5.1 匯出系統除錯診斷包 (Diagnostic Dump)
    const handleExportDiagnostic = async () => {
        try {
            await downloadDiagnosticDump();
            toast.success('已匯出系統除錯診斷包 (.json)！');
        } catch (err) {
            toast.error(`匯出診斷包失敗: ${err.message}`);
        }
    };

    // 6. 執行旅程日期平移
    const handleShiftDates = async () => {
        if (!newStartDate || !activeTrip) return;
        const diff = calculateDayDifference(activeTrip.startDate, newStartDate);
        if (diff === 0) {
            toast.info('新出發日期與原日期相同，無需平移');
            return;
        }

        if (!confirm(`確定要將旅程出發日平移 ${diff > 0 ? `+${diff}` : diff} 天至 ${newStartDate} 嗎？\n所有行程日程、機票航班時間與住宿日期將同步重新錨定。`)) {
            return;
        }

        setIsShifting(true);
        try {
            const res = await shiftTripDates(activeTrip.id, newStartDate, {
                tickets,
                hotels: rawHotels,
                activities,
                setTickets: ticketContext.setTickets,
                setHotels: hotelContext.setHotels,
                setActivities: activityContext.setActivities,
            });
            const extraCount = (res.shiftedTicketsCount || 0) + (res.shiftedHotelsCount || 0) + (res.shiftedActivitiesCount || 0);
            toast.success(`🎉 旅程日期已成功平移 ${res.dayDiff > 0 ? `+${res.dayDiff}` : res.dayDiff} 天！已更新 ${res.shiftedPlansCount} 個日程、${res.shiftedReservationsCount} 筆預訂與 ${extraCount} 筆機酒活動。`);
            await refreshTrips(activeTrip.id);
            onClose();
        } catch (err) {
            toast.error(`平移失敗: ${err.message}`);
        } finally {
            setIsShifting(false);
        }
    };

    // 7. 開啟手冊預覽時讀取景點、費用與行李資料
    const handleOpenBrochure = async () => {
        if (!activeTrip) return;
        try {
            const [pItems, expItems, places] = await Promise.all([
                packingRepo.getByTrip(activeTrip.id).catch(() => []),
                expenseRepo.getByTrip(activeTrip.id).catch(() => []),
                placeItemRepo.getByTrip(activeTrip.id).catch(() => []),
            ]);
            setPackingItems(pItems);
            setExpenses(expItems);
            setTripPlaces(places);
            setIsBrochureOpen(true);
        } catch {
            setIsBrochureOpen(true);
        }
    };

    const dayDiff = activeTrip ? calculateDayDifference(activeTrip.startDate, newStartDate) : 0;

    // ── API 寫入與拉取操作 ──────────────────────────────────────────────────
    const handleSaveApiConfig = () => {
        const saved = saveApiSyncConfig(apiConfig);
        setApiConfig(saved);
        toast.success('已儲存 API 寫入與自動拉取設定！');
    };

    const handleForcePullFromApi = async () => {
        const saved = saveApiSyncConfig(apiConfig);
        setApiConfig(saved);
        if (!saved.apiToken) {
            toast.error('請先填寫 API Secret Token');
            return;
        }
        setIsSyncingApi(true);
        try {
            const res = await pullFromIngestApi({
                endpointUrl: saved.endpointUrl,
                apiToken: saved.apiToken,
                channel: saved.channel,
                sinceRevision: -1, // 強制完整拉取
            });

            if (!res?.data) {
                toast.info(`雲端通道 (${saved.channel}) 目前尚無寫入資料`);
                return;
            }

            const parsed = parseUnifiedJsonInput(JSON.stringify(res.data), { activeTrip });
            const importRes = await executeUnifiedJsonImport({
                parsed,
                activeTrip,
                mode: saved.importMode || 'replace',
                tripTarget: activeTrip ? 'current' : 'new',
                dataSetters: {
                    setTickets: ticketContext.setTickets,
                    setTripLabels: ticketContext.setTripLabels,
                    setTripBudgets: ticketContext.setTripBudgets,
                    setHotels: hotelContext.setHotels,
                    setActivities: activityContext.setActivities,
                    setOverrides: overrideContext.setOverrides,
                },
            });

            setLastSyncedRevision(saved.channel, res.revision || 1);
            await refreshTrips(importRes.targetTripId || activeTrip?.id || null);
            toast.success(`🎉 已從雲端 API 通道 (${saved.channel}) 拉取並同步完成！(版本 #${res.revision || 1})`);
            onClose();
        } catch (err) {
            toast.error(`API 拉取失敗：${err.message}`);
        } finally {
            setIsSyncingApi(false);
        }
    };

    const handlePushCurrentToApi = async () => {
        const saved = saveApiSyncConfig(apiConfig);
        setApiConfig(saved);
        if (!saved.apiToken) {
            toast.error('請先填寫 API Secret Token');
            return;
        }
        setIsSyncingApi(true);
        try {
            const [places, pItems, expItems, todos] = activeTrip
                ? await Promise.all([
                    placeItemRepo.getByTrip(activeTrip.id).catch(() => []),
                    packingRepo.getByTrip(activeTrip.id).catch(() => []),
                    expenseRepo.getByTrip(activeTrip.id).catch(() => []),
                    todoRepo.getByTrip(activeTrip.id).catch(() => []),
                ])
                : [[], [], [], []];

            const payload = buildFullJsonExport({
                trip: activeTrip,
                dayPlans,
                places,
                reservations,
                expenses: expItems,
                packingItems: pItems,
                todos,
                tickets,
                hotels: rawHotels,
                activities,
                tripLabels,
                tripBudgets,
                tripOverrides,
            });

            const res = await pushToIngestApi({
                endpointUrl: saved.endpointUrl,
                apiToken: saved.apiToken,
                channel: saved.channel,
                payload,
                mode: 'replace',
            });

            setLastSyncedRevision(saved.channel, res.revision || 1);
            toast.success(`☁️ 已將目前行程推送至 API 通道 (${saved.channel})！版本 #${res.revision}`);
        } catch (err) {
            toast.error(`API 推送失敗：${err.message}`);
        } finally {
            setIsSyncingApi(false);
        }
    };

    const handleCopyCurlExample = async () => {
        const text = buildIngestCurlExamples(apiConfig);
        try {
            await navigator.clipboard.writeText(text);
            toast.success('已複製 curl API 寫入指令範例！');
        } catch {
            toast.error('複製失敗，請手動選取下方指令');
        }
    };

    // ── 子金鑰簽發、查詢與撤銷操作 (強制使用記憶體暫存之 Master Token，不寫入 localStorage) ──
    const handleLoadSubKeys = async () => {
        const token = masterAdminToken.trim();
        if (!token) {
            toast.error('請於下方「Master Admin Token」欄位輸入主管理金鑰（不會寫入 localStorage）');
            return;
        }
        setIsLoadingSubKeys(true);
        try {
            const list = await listSubKeys({
                endpointUrl: apiConfig.endpointUrl,
                apiToken: token,
            });
            setSubKeys(list);
            toast.success(`已載入 ${list.length} 組子金鑰`);
        } catch (err) {
            toast.error(`載入子金鑰失敗：${err.message}`);
        } finally {
            setIsLoadingSubKeys(false);
        }
    };

    const handleCreateSubKey = async () => {
        const token = masterAdminToken.trim();
        if (!token) {
            toast.error('請先輸入 Master Admin Token 才能簽發子金鑰');
            return;
        }
        if (!newKeyLabel.trim()) {
            toast.error('請輸入子金鑰名稱／用途（例如：旅伴小明、iOS 捷徑）');
            return;
        }

        const permissions =
            newKeyPermMode === 'write_only'
                ? ['write']
                : newKeyPermMode === 'read_only'
                    ? ['read']
                    : ['read', 'write'];

        const allowedChannels = String(newKeyChannels || '*')
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean);

        setIsLoadingSubKeys(true);
        try {
            const created = await createSubKey({
                endpointUrl: apiConfig.endpointUrl,
                apiToken: token,
                label: newKeyLabel.trim(),
                permissions,
                allowedChannels: allowedChannels.length > 0 ? allowedChannels : ['*'],
                expiresInDays: Number(newKeyExpiresDays) || 0,
            });
            setNewlyIssuedKey(created);
            setNewKeyLabel('');
            const list = await listSubKeys({
                endpointUrl: apiConfig.endpointUrl,
                apiToken: token,
            });
            setSubKeys(list);
            toast.success(`🔑 已簽發子金鑰「${created.label}」！請立即複製保存`);
        } catch (err) {
            toast.error(`簽發失敗：${err.message}`);
        } finally {
            setIsLoadingSubKeys(false);
        }
    };

    const handleRevokeSubKey = async (keyItem) => {
        const token = masterAdminToken.trim();
        if (!token) {
            toast.error('請先輸入 Master Admin Token 才能撤銷子金鑰');
            return;
        }
        setIsLoadingSubKeys(true);
        try {
            await revokeSubKey({
                endpointUrl: apiConfig.endpointUrl,
                apiToken: token,
                keyId: keyItem.id,
            });
            setSubKeys((prev) => prev.filter((k) => k.id !== keyItem.id));
            if (newlyIssuedKey?.id === keyItem.id) {
                setNewlyIssuedKey(null);
            }
            toast.success(`🗑️ 已立即撤銷子金鑰「${keyItem.label}」`);
        } catch (err) {
            toast.error(`撤銷失敗：${err.message}`);
        } finally {
            setIsLoadingSubKeys(false);
        }
    };

    const tabs = [
        { key: 'json_import', label: '📦 JSON 整包匯入' },
        { key: 'api_sync', label: '🔌 API 寫入接口' },
        ...(activeTrip ? [{ key: 'import', label: '📥 景點匯入' }] : []),
        { key: 'export', label: '📤 資料匯出' },
        ...(activeTrip ? [{ key: 'shift', label: '🗓️ 日期平移' }] : []),
        ...(activeTrip ? [{ key: 'brochure', label: '📖 旅遊手冊' }] : []),
    ];

    const summaryBadges = parsedJson
        ? [
            { label: '日程天數', value: parsedJson.summary.daysCount },
            { label: '景點地標', value: parsedJson.summary.placesCount },
            { label: '機票訂單', value: parsedJson.summary.ticketsCount },
            { label: '飯店住宿', value: parsedJson.summary.hotelsCount },
            { label: '票券活動', value: parsedJson.summary.activitiesCount },
            { label: '其他預訂', value: parsedJson.summary.reservationsCount },
            { label: '日常支出', value: parsedJson.summary.expensesCount },
            { label: '行李項目', value: parsedJson.summary.packingCount },
            { label: '行前待辦', value: parsedJson.summary.todosCount },
        ].filter((b) => b.value > 0)
        : [];

    const modalContent = (
        <>
            <div className="fixed inset-0 z-[70] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full overflow-hidden border border-gray-100 flex flex-col max-h-[90vh]">
                    {/* Header */}
                    <div className="p-4 sm:p-5 bg-slate-900 text-white flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-500 to-emerald-400 flex items-center justify-center text-white shadow-md">
                                <Share2 className="w-4 h-4" />
                            </div>
                            <div>
                                <h3 className="text-sm font-bold">匯入匯出與工具中心</h3>
                                <p className="text-[11px] text-slate-400 font-medium">
                                    {activeTrip ? activeTrip.title : '尚未選擇旅程（可直接匯入建立新旅程）'}
                                </p>
                            </div>
                        </div>
                        <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-white rounded-lg transition">
                            <X className="w-5 h-5" />
                        </button>
                    </div>

                    {/* Navigation Tabs */}
                    <div className="flex items-center border-b border-gray-200 bg-slate-50 px-4 pt-2 gap-1 overflow-x-auto scrollbar-none">
                        {tabs.map((tab) => (
                            <button
                                key={tab.key}
                                onClick={() => setActiveTab(tab.key)}
                                className={`px-3.5 py-2.5 text-xs font-bold rounded-t-xl transition-all border-b-2 whitespace-nowrap ${
                                    activeTab === tab.key
                                        ? 'bg-white border-indigo-600 text-indigo-700 shadow-sm'
                                        : 'border-transparent text-slate-500 hover:text-slate-800'
                                }`}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>

                    {/* Tab Content */}
                    <div className="p-5 overflow-y-auto space-y-4 flex-1">
                        {/* ── Tab 0: JSON 一次性整包匯入 ───────────────────────────── */}
                        {activeTab === 'json_import' && (
                            <div className="space-y-4">
                                <div className="flex flex-wrap items-center justify-between gap-2 bg-indigo-50/70 border border-indigo-100 rounded-2xl p-3">
                                    <p className="text-[11px] text-indigo-900 leading-relaxed flex-1">
                                        支援一次匯入完整多日行程（<code className="font-mono font-bold">trip / days / places / reservations / expenses / packingItems / todos</code>）及機票住宿活動（<code className="font-mono font-bold">tickets / hotels / activities</code>）。
                                    </p>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <button
                                            type="button"
                                            onClick={handleCopyJsonTemplate}
                                            className="px-2.5 py-1.5 bg-white hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-[11px] font-bold flex items-center gap-1 transition"
                                        >
                                            <Copy className="w-3 h-3" />
                                            <span>複製範本</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleDownloadJsonTemplate}
                                            className="px-2.5 py-1.5 bg-white hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-lg text-[11px] font-bold flex items-center gap-1 transition"
                                        >
                                            <Download className="w-3 h-3" />
                                            <span>下載範本</span>
                                        </button>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {/* 上傳 JSON 檔 */}
                                    <div className="border-2 border-dashed border-indigo-200 hover:border-indigo-400 bg-indigo-50/40 rounded-2xl p-4 text-center relative cursor-pointer transition flex flex-col items-center justify-center min-h-[124px]">
                                        <input
                                            type="file"
                                            accept=".json,application/json"
                                            onChange={handleJsonFileUpload}
                                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                        />
                                        <FileJson className="w-6 h-6 text-indigo-600 mb-1.5" />
                                        <p className="text-xs font-bold text-slate-800">上傳 .json 檔案</p>
                                        <p className="text-[10px] text-slate-500 mt-0.5">支援完整行程包與 reverse-tickets.json</p>
                                    </div>

                                    {/* 直接貼上 JSON */}
                                    <div className="flex flex-col gap-2">
                                        <textarea
                                            rows={4}
                                            value={jsonText}
                                            onChange={(e) => setJsonText(e.target.value)}
                                            placeholder='直接貼上 JSON 內容（支援 ```json 區塊）'
                                            className="w-full border border-gray-200 rounded-xl p-2.5 text-[11px] focus:outline-none focus:border-indigo-500 resize-none font-mono"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => parseJsonSource(jsonText)}
                                            disabled={!jsonText.trim()}
                                            className="w-full py-2 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 text-indigo-700 border border-indigo-200 rounded-xl text-xs font-bold transition"
                                        >
                                            解析並預覽 JSON 內容
                                        </button>
                                    </div>
                                </div>

                                {jsonError && (
                                    <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700 font-medium">
                                        ⚠️ {jsonError}
                                    </div>
                                )}

                                {parsedJson && (
                                    <div className="border border-emerald-200 rounded-2xl p-4 space-y-3 bg-emerald-50/40">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-bold text-emerald-900">
                                                ✅ 解析成功{parsedJson.summary.tripTitle ? `：${parsedJson.summary.tripTitle}` : ''}
                                            </span>
                                            <span className="text-[11px] font-mono font-bold text-emerald-700">
                                                共 {parsedJson.summary.totalItems} 筆項目
                                            </span>
                                        </div>

                                        {summaryBadges.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5">
                                                {summaryBadges.map((b) => (
                                                    <span
                                                        key={b.label}
                                                        className="px-2.5 py-1 rounded-lg bg-white border border-emerald-200 text-[11px] font-bold text-slate-700"
                                                    >
                                                        {b.label} <span className="text-indigo-600 font-mono">{b.value}</span>
                                                    </span>
                                                ))}
                                            </div>
                                        )}

                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                                            {parsedJson.summary.hasTripScopedData && (
                                                <div>
                                                    <label className="block text-[11px] font-bold text-slate-600 mb-1">目標旅程</label>
                                                    <select
                                                        value={activeTrip ? tripTarget : 'new'}
                                                        onChange={(e) => setTripTarget(e.target.value)}
                                                        disabled={!activeTrip}
                                                        className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs bg-white font-bold text-slate-800"
                                                    >
                                                        {activeTrip && (
                                                            <option value="current">匯入至目前旅程（{activeTrip.title}）</option>
                                                        )}
                                                        <option value="new">建立為全新旅程</option>
                                                    </select>
                                                </div>
                                            )}

                                            <div>
                                                <label className="block text-[11px] font-bold text-slate-600 mb-1">寫入策略</label>
                                                <select
                                                    value={importMode}
                                                    onChange={(e) => setImportMode(e.target.value)}
                                                    className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs bg-white font-bold text-slate-800"
                                                >
                                                    <option value="merge">合併寫入（保留既有資料）</option>
                                                    <option value="replace">覆寫取代（清除對應舊資料）</option>
                                                </select>
                                            </div>
                                        </div>

                                        <button
                                            type="button"
                                            onClick={handleConfirmJsonImport}
                                            disabled={isImportingJson}
                                            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition"
                                        >
                                            {isImportingJson ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                            <span>確認一次性匯入全部資料</span>
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ── Tab 0.5: 具備認證之外部 API 寫入與自動拉取接口 ───────── */}
                        {activeTab === 'api_sync' && (
                            <div className="space-y-4">
                                <div className="bg-indigo-50/70 border border-indigo-100 rounded-2xl p-3 text-[11px] text-indigo-900 leading-relaxed">
                                    透過 Cloudflare Worker <code className="font-mono font-bold">/api/v1/ingest</code> 接口，外部腳本、AI 工具或 <code className="font-mono font-bold">curl</code> 可帶入 <code className="font-mono font-bold">Authorization: Bearer &lt;TOKEN&gt;</code> 或 <code className="font-mono font-bold">X-API-Key</code> 直接寫入單筆機票／飯店／活動或整包行程，網頁重新整理時將自動拉取最新版本。
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    <div className="sm:col-span-2">
                                        <label className="block text-[11px] font-bold text-slate-700 mb-1">Worker API 端點網址 (Endpoint URL)</label>
                                        <input
                                            type="url"
                                            value={apiConfig.endpointUrl}
                                            onChange={(e) => setApiConfig((p) => ({ ...p, endpointUrl: e.target.value }))}
                                            placeholder="https://flight-api-proxy.your-account.workers.dev"
                                            className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-indigo-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-[11px] font-bold text-slate-700 mb-1">日常同步子金鑰 (建議使用受限 ltp_sk_...)</label>
                                        <input
                                            type="password"
                                            value={apiConfig.apiToken}
                                            onChange={(e) => setApiConfig((p) => ({ ...p, apiToken: e.target.value }))}
                                            placeholder="建議填入唯讀或單通道子金鑰，勿存 Master Token"
                                            className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-indigo-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-[11px] font-bold text-slate-700 mb-1">雲端通道名稱 (Channel)</label>
                                        <input
                                            type="text"
                                            value={apiConfig.channel}
                                            onChange={(e) => setApiConfig((p) => ({ ...p, channel: e.target.value }))}
                                            placeholder="default"
                                            className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:border-indigo-500"
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-[11px] font-bold text-slate-700 mb-1">拉取後本地寫入策略</label>
                                        <select
                                            value={apiConfig.importMode || 'replace'}
                                            onChange={(e) => setApiConfig((p) => ({ ...p, importMode: e.target.value }))}
                                            className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs bg-white font-bold text-slate-800"
                                        >
                                            <option value="replace">覆寫同步（以雲端最新完整狀態為主）</option>
                                            <option value="merge">合併同步（保留本地其他項目）</option>
                                        </select>
                                    </div>

                                    <div className="flex items-center pt-4">
                                        <label className="flex items-center gap-2 cursor-pointer text-xs font-bold text-slate-700">
                                            <input
                                                type="checkbox"
                                                checked={apiConfig.autoPullOnLoad !== false}
                                                onChange={(e) => setApiConfig((p) => ({ ...p, autoPullOnLoad: e.target.checked }))}
                                                className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                                            />
                                            <span>每次開頁／重新整理自動拉取最新寫入</span>
                                        </label>
                                    </div>
                                </div>

                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                    <button
                                        type="button"
                                        onClick={handleSaveApiConfig}
                                        className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition"
                                    >
                                        💾 儲存設定
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleForcePullFromApi}
                                        disabled={isSyncingApi}
                                        className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition"
                                    >
                                        {isSyncingApi ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                                        <span>立即從 API 拉取同步</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handlePushCurrentToApi}
                                        disabled={isSyncingApi}
                                        className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 transition"
                                    >
                                        {isSyncingApi ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                                        <span>將目前行程推送至 API 通道</span>
                                    </button>
                                </div>

                                <div className="border border-slate-200 rounded-2xl overflow-hidden">
                                    <div className="bg-slate-100 px-3 py-2 flex items-center justify-between border-b border-slate-200">
                                        <span className="text-[11px] font-bold text-slate-700">
                                            💻 外部寫入 curl 範例（目前同步版本：#{getLastSyncedRevision(apiConfig.channel)}）
                                        </span>
                                        <button
                                            type="button"
                                            onClick={handleCopyCurlExample}
                                            className="px-2 py-1 bg-white hover:bg-indigo-50 text-indigo-700 border border-slate-200 rounded-lg text-[11px] font-bold flex items-center gap-1 transition"
                                        >
                                            <Copy className="w-3 h-3" />
                                            <span>複製指令</span>
                                        </button>
                                    </div>
                                    <pre className="p-3 bg-slate-950 text-slate-200 text-[10px] font-mono overflow-x-auto leading-relaxed max-h-48">
                                        {buildIngestCurlExamples(apiConfig)}
                                    </pre>
                                </div>

                                {/* ── 子金鑰管理中心 (Sub-Key Management) ──────────────────── */}
                                <div className="border border-indigo-200/80 bg-slate-50/70 rounded-2xl p-4 space-y-3">
                                    <div className="flex items-center justify-between gap-2 flex-wrap">
                                        <div className="flex items-center gap-1.5">
                                            <Key className="w-4 h-4 text-indigo-600" />
                                            <h4 className="text-xs font-bold text-slate-800">
                                                🔑 多組子金鑰管理介面（分發給旅伴／腳本／AI，可單獨限權與撤銷）
                                            </h4>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={handleLoadSubKeys}
                                            disabled={isLoadingSubKeys}
                                            className="px-2.5 py-1 bg-white hover:bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-lg text-[11px] font-bold flex items-center gap-1 transition"
                                        >
                                            <RefreshCw className={`w-3 h-3 ${isLoadingSubKeys ? 'animate-spin' : ''}`} />
                                            <span>重新載入清單</span>
                                        </button>
                                    </div>

                                    <p className="text-[11px] text-slate-500 leading-relaxed">
                                        為降低 XSS 外洩風險，<b>Master Admin Token 僅暫存於記憶體</b>（關閉視窗即自動清空，絕不寫入 <code className="font-mono">localStorage</code>）。日常開頁自動拉取請使用下方簽發的受限子金鑰 (<code className="font-mono">ltp_sk_...</code>)。
                                    </p>

                                    <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-2.5">
                                        <label className="block text-[10px] font-bold text-amber-900 mb-1">
                                            🛡️ Master Admin Token（僅本次操作使用，不落盤儲存）
                                        </label>
                                        <input
                                            type="password"
                                            value={masterAdminToken}
                                            onChange={(e) => setMasterAdminToken(e.target.value)}
                                            placeholder="輸入 Worker 的 API_SECRET_TOKEN 以管理子金鑰"
                                            className="w-full border border-amber-300 bg-white rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-amber-500"
                                        />
                                    </div>

                                    {/* 簽發新子金鑰表單 */}
                                    <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 bg-white p-3 rounded-xl border border-slate-200">
                                        <div className="sm:col-span-4">
                                            <label className="block text-[10px] font-bold text-slate-600 mb-1">名稱／用途</label>
                                            <input
                                                type="text"
                                                value={newKeyLabel}
                                                onChange={(e) => setNewKeyLabel(e.target.value)}
                                                placeholder="例：旅伴小明 / iOS 捷徑"
                                                className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                                            />
                                        </div>
                                        <div className="sm:col-span-3">
                                            <label className="block text-[10px] font-bold text-slate-600 mb-1">授權權限</label>
                                            <select
                                                value={newKeyPermMode}
                                                onChange={(e) => setNewKeyPermMode(e.target.value)}
                                                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs bg-white font-bold text-slate-700"
                                            >
                                                <option value="read_write">讀寫 (read + write)</option>
                                                <option value="write_only">僅寫入 (write-only)</option>
                                                <option value="read_only">唯讀 (read-only)</option>
                                            </select>
                                        </div>
                                        <div className="sm:col-span-3">
                                            <label className="block text-[10px] font-bold text-slate-600 mb-1">允許通道 (逗號分隔)</label>
                                            <input
                                                type="text"
                                                value={newKeyChannels}
                                                onChange={(e) => setNewKeyChannels(e.target.value)}
                                                placeholder="* 或 default,tokyo2026"
                                                className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-indigo-500"
                                            />
                                        </div>
                                        <div className="sm:col-span-2">
                                            <label className="block text-[10px] font-bold text-slate-600 mb-1">效期</label>
                                            <select
                                                value={newKeyExpiresDays}
                                                onChange={(e) => setNewKeyExpiresDays(Number(e.target.value))}
                                                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs bg-white font-bold text-slate-700"
                                            >
                                                <option value={0}>永久</option>
                                                <option value={7}>7 天</option>
                                                <option value={30}>30 天</option>
                                                <option value={90}>90 天</option>
                                            </select>
                                        </div>
                                        <div className="sm:col-span-12 flex justify-end pt-1">
                                            <button
                                                type="button"
                                                onClick={handleCreateSubKey}
                                                disabled={isLoadingSubKeys}
                                                className="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold flex items-center gap-1 transition"
                                            >
                                                <Plus className="w-3.5 h-3.5" />
                                                <span>簽發新子金鑰</span>
                                            </button>
                                        </div>
                                    </div>

                                    {/* 剛簽發之新子金鑰一次性明文顯示橫幅 */}
                                    {newlyIssuedKey && (
                                        <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-xl space-y-2">
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-xs font-bold text-emerald-900">
                                                    🎉 已簽發「{newlyIssuedKey.label}」（明文僅顯示這一次，請立即複製保存！）
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={async () => {
                                                        try {
                                                            await navigator.clipboard.writeText(newlyIssuedKey.token);
                                                            toast.success('已複製子金鑰明文！');
                                                        } catch {
                                                            toast.error('請手動選取下方金鑰複製');
                                                        }
                                                    }}
                                                    className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold flex items-center gap-1 shrink-0"
                                                >
                                                    <Copy className="w-3 h-3" />
                                                    <span>複製子金鑰</span>
                                                </button>
                                            </div>
                                            <div className="p-2 bg-white border border-emerald-200 rounded-lg font-mono text-xs text-slate-900 select-all break-all">
                                                {newlyIssuedKey.token}
                                            </div>
                                        </div>
                                    )}

                                    {/* 已簽發子金鑰清單 */}
                                    {subKeys.length > 0 ? (
                                        <div className="space-y-1.5">
                                            {subKeys.map((k) => (
                                                <div
                                                    key={k.id}
                                                    className="bg-white border border-slate-200 rounded-xl px-3 py-2 flex items-center justify-between gap-2 flex-wrap"
                                                >
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-2 flex-wrap">
                                                            <span className="text-xs font-bold text-slate-800">{k.label}</span>
                                                            <code className="text-[10px] font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                                                                {k.tokenMask}
                                                            </code>
                                                            <span className="text-[10px] font-bold bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded">
                                                                {(k.permissions || []).join(' + ')}
                                                            </span>
                                                            <span className="text-[10px] font-mono bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded">
                                                                通道: {(k.allowedChannels || ['*']).join(', ')}
                                                            </span>
                                                            {k.isExpired && (
                                                                <span className="text-[10px] font-bold bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded">
                                                                    已過期
                                                                </span>
                                                            )}
                                                        </div>
                                                        <div className="text-[10px] text-slate-400 mt-0.5">
                                                            建立於 {k.createdAt ? k.createdAt.slice(0, 10) : '-'}
                                                            {k.expiresAt ? ` · 到期日 ${k.expiresAt.slice(0, 10)}` : ' · 永久有效'}
                                                        </div>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRevokeSubKey(k)}
                                                        disabled={isLoadingSubKeys}
                                                        className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-[11px] font-bold flex items-center gap-1 transition shrink-0"
                                                    >
                                                        <Trash2 className="w-3 h-3" />
                                                        <span>撤銷</span>
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="text-center py-3 text-[11px] text-slate-400 bg-white rounded-xl border border-dashed border-slate-200">
                                            尚未載入或尚未簽發任何子金鑰（點擊右上角「重新載入清單」或於上方直接簽發）
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* ── Tab 1: 景點匯入 ────────────────────────────────────── */}
                        {activeTab === 'import' && activeTrip && (
                            <div className="space-y-4">
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {/* 檔案上傳框 */}
                                    <div className="border-2 border-dashed border-indigo-200 hover:border-indigo-400 bg-indigo-50/40 rounded-2xl p-4 text-center relative cursor-pointer transition">
                                        <input
                                            type="file"
                                            accept=".gpx,.kml,.kmz"
                                            onChange={handleFileUpload}
                                            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                                        />
                                        <Upload className="w-6 h-6 text-indigo-600 mx-auto mb-1.5" />
                                        <p className="text-xs font-bold text-slate-800">上傳 GPX / KML / KMZ 檔案</p>
                                        <p className="text-[10px] text-slate-500 mt-0.5">自動抽取航點、景點與經緯度</p>
                                    </div>

                                    {/* 地圖連結貼上框 */}
                                    <div className="flex flex-col gap-2">
                                        <textarea
                                            rows={3}
                                            value={pastedLinks}
                                            onChange={(e) => setPastedLinks(e.target.value)}
                                            placeholder="貼上 Google Maps (含 maps.app.goo.gl 短網址) / Naver Maps / 經緯度或景點名稱 (支援每行一筆批次匯入)"
                                            className="w-full border border-gray-200 rounded-xl p-2.5 text-xs focus:outline-none focus:border-indigo-500 resize-none font-mono"
                                        />
                                        <button
                                            onClick={handleParseLinks}
                                            disabled={isParsingLinks || !pastedLinks.trim()}
                                            className="w-full py-2 bg-indigo-50 hover:bg-indigo-100 disabled:opacity-50 text-indigo-700 border border-indigo-200 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5"
                                        >
                                            {isParsingLinks ? (
                                                <>
                                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    <span>智慧解析與聯網定位中...</span>
                                                </>
                                            ) : (
                                                <span>智慧解析文字連結或景點</span>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                {/* 解析結果清單 */}
                                {parsedPlaces.length > 0 && (
                                    <div className="border border-gray-200 rounded-2xl p-4 space-y-3 bg-slate-50">
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="font-bold text-slate-800">待匯入景點 ({parsedPlaces.length})</span>
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-slate-500">匯入至：</span>
                                                <select
                                                    value={selectedTargetDay}
                                                    onChange={(e) => setSelectedTargetDay(Number(e.target.value))}
                                                    className="border border-gray-300 rounded-lg px-2 py-1 text-xs bg-white font-bold text-slate-800"
                                                >
                                                    {tripDays.map((td, idx) => (
                                                        <option key={idx} value={idx}>
                                                            Day {idx + 1} {td.date ? `(${td.date})` : ''}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                        </div>

                                        <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                                            {parsedPlaces.map((p, idx) => (
                                                <div key={idx} className="bg-white p-2.5 rounded-xl border border-gray-200 text-xs flex items-center justify-between gap-2 shadow-xs">
                                                    <div className="truncate flex-1">
                                                        <span className="font-bold text-slate-800">{p.name}</span>
                                                        <span className="text-[10px] text-slate-400 font-mono ml-2">
                                                            ({p.lat.toFixed(4)}, {p.lng.toFixed(4)})
                                                        </span>
                                                    </div>
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 uppercase font-mono">
                                                        {p.source}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>

                                        <button
                                            onClick={handleConfirmImport}
                                            disabled={isImporting}
                                            className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition"
                                        >
                                            {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                            <span>確認匯入至 Day {selectedTargetDay + 1}</span>
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ── Tab 2: 資料匯出 ────────────────────────────────────── */}
                        {activeTab === 'export' && (
                            <div className="space-y-4">
                                <div className="p-4 rounded-2xl border border-indigo-200 bg-indigo-50/50 space-y-2">
                                    <div className="flex items-center gap-2 text-indigo-800 font-bold text-xs">
                                        <FileJson className="w-4 h-4 text-indigo-600" />
                                        <span>完整旅程與票券備份 (.json)</span>
                                    </div>
                                    <p className="text-[11px] text-indigo-900/80 leading-relaxed">
                                        匯出當前旅程全部日程、景點、預訂、費用、行李與待辦，以及全域機票、住宿、活動資料。此檔案可直接於「JSON 整包匯入」無損還原。
                                    </p>
                                    <button
                                        onClick={handleExportFullJson}
                                        className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm"
                                    >
                                        <Download className="w-4 h-4" />
                                        <span>下載完整備份 (.json)</span>
                                    </button>
                                </div>

                                {activeTrip && (
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="p-4 rounded-2xl border border-gray-200 bg-slate-50 space-y-2">
                                            <div className="flex items-center gap-2 text-indigo-700 font-bold text-xs">
                                                <Calendar className="w-4 h-4" />
                                                <span>iCalendar (.ics) 行事曆</span>
                                            </div>
                                            <p className="text-[11px] text-slate-500 leading-relaxed">
                                                包含機票航班、住宿飯店、每日景點參訪時間與行前待辦截止日，相容 Apple Calendar、Google 日曆與 Outlook。
                                            </p>
                                            <button
                                                onClick={handleExportIcs}
                                                className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5"
                                            >
                                                <Download className="w-4 h-4" />
                                                <span>下載 .ics 檔案</span>
                                            </button>
                                        </div>

                                        <div className="p-4 rounded-2xl border border-gray-200 bg-slate-50 space-y-2">
                                            <div className="flex items-center gap-2 text-emerald-700 font-bold text-xs">
                                                <Compass className="w-4 h-4" />
                                                <span>GPS 航跡與地標 (.gpx)</span>
                                            </div>
                                            <p className="text-[11px] text-slate-500 leading-relaxed">
                                                標準 GPX 1.1 格式，匯出所有行程景點坐標點位與連續旅遊路線，可匯入 Garmin、OsmAnd、CoMaps 與 Google Earth。
                                            </p>
                                            <button
                                                onClick={handleExportGpx}
                                                className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5"
                                            >
                                                <Download className="w-4 h-4" />
                                                <span>下載 .gpx 檔案</span>
                                            </button>
                                        </div>
                                    </div>
                                )}

                                <div className="p-4 rounded-2xl border border-amber-200 bg-amber-50/50 space-y-2">
                                    <div className="flex items-center gap-2 text-amber-800 font-bold text-xs">
                                        <Bug className="w-4 h-4 text-amber-600" />
                                        <span>系統除錯診斷包 (Diagnostic Dump)</span>
                                    </div>
                                    <p className="text-[11px] text-amber-900/80 leading-relaxed">
                                        零成本客戶端診斷報告。一鍵匯出瀏覽器環境、IndexedDB 儲存庫健康狀態與記錄統計（不含敏感個資），供排查資料異常或離線同步疑難問題。
                                    </p>
                                    <button
                                        onClick={handleExportDiagnostic}
                                        className="w-full py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 shadow-sm"
                                    >
                                        <Download className="w-4 h-4" />
                                        <span>下載系統診斷報告 (.json)</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* ── Tab 3: 日期平移 ────────────────────────────────────── */}
                        {activeTab === 'shift' && activeTrip && (
                            <div className="space-y-4">
                                <div className="p-4 rounded-2xl bg-indigo-50/50 border border-indigo-100 space-y-3">
                                    <div className="text-xs text-indigo-900 font-bold flex items-center gap-1.5">
                                        <Calendar className="w-4 h-4 text-indigo-600" />
                                        <span>智慧重新錨定旅程日程 (Move Trip Dates)</span>
                                    </div>
                                    <p className="text-[11px] text-indigo-800/80 leading-relaxed">
                                        出發日期延期或提前時，輸入全新出發日，系統將自動計算天數差，並級聯重新錨定所有每日日程、機票航班時間、住宿入住退房日與待辦事項截止日。
                                    </p>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                                        <div>
                                            <label className="text-[11px] font-bold text-slate-500 mb-1 block">目前出發日期</label>
                                            <input
                                                type="text"
                                                disabled
                                                value={activeTrip.startDate}
                                                className="w-full bg-slate-100 border border-slate-200 rounded-xl px-3 py-1.5 text-xs text-slate-500 font-mono"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[11px] font-bold text-slate-700 mb-1 block">設定全新出發日</label>
                                            <input
                                                type="date"
                                                value={newStartDate}
                                                onChange={(e) => setNewStartDate(e.target.value)}
                                                className="w-full bg-white border border-gray-300 rounded-xl px-3 py-1.5 text-xs font-bold focus:outline-none focus:border-indigo-500"
                                            />
                                        </div>
                                    </div>

                                    {dayDiff !== 0 && (
                                        <div className="p-2.5 rounded-xl bg-white border border-indigo-200 text-xs flex items-center justify-between text-indigo-900">
                                            <span>預估調整幅度：</span>
                                            <span className="font-bold font-mono text-sm text-indigo-600">
                                                {dayDiff > 0 ? `+${dayDiff}` : dayDiff} 天
                                            </span>
                                        </div>
                                    )}

                                    <button
                                        onClick={handleShiftDates}
                                        disabled={isShifting || dayDiff === 0}
                                        className={`w-full py-2.5 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                                            dayDiff === 0
                                                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                                                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm'
                                        }`}
                                    >
                                        {isShifting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                                        <span>確認平移並重新錨定全旅程</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* ── Tab 4: 專業手冊 ────────────────────────────────────── */}
                        {activeTab === 'brochure' && activeTrip && (
                            <div className="space-y-4 text-center py-4">
                                <div className="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-600 mx-auto flex items-center justify-center mb-2 shadow-inner">
                                    <BookOpen className="w-7 h-7" />
                                </div>
                                <h4 className="text-base font-bold text-slate-800">專業 A4 旅遊手冊預覽與列印</h4>
                                <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
                                    自動彙整封面、機票航班確認碼、住宿憑證、每日詳細景點時間軸、重要行前檢查與費用摘要，隨時列印或另存為高品質 PDF。
                                </p>
                                <button
                                    onClick={handleOpenBrochure}
                                    className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-2xl text-xs shadow-md transition inline-flex items-center gap-2"
                                >
                                    <BookOpen className="w-4 h-4" />
                                    <span>開啟旅遊手冊排版視窗</span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* 旅遊手冊 Modal */}
            {activeTrip && (
                <TripBrochureModal
                    isOpen={isBrochureOpen}
                    onClose={() => setIsBrochureOpen(false)}
                    trip={activeTrip}
                    dayPlans={dayPlans}
                    places={tripPlaces}
                    reservations={unifiedReservations}
                    packingItems={packingItems}
                    expenses={expenses}
                />
            )}
        </>
    );

    return typeof document !== 'undefined' && document.body ? createPortal(modalContent, document.body) : modalContent;
}
