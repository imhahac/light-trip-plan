/**
 * DayPlanTimeline.jsx
 * 每日日程時間軸排程器：
 * - 顯示每日行程清單 (Day 1, Day 2...)
 * - 整合 Open-Meteo 天氣預報徽章
 * - 支援 2-opt TSP 一鍵路徑最佳化 (鎖定錨點保護)
 * - 支援 OSRM 道路行車線計算與 Google Maps 外部導航
 * - 支援景點搜尋 (OSM Nominatim) 與維基百科圖文富化
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { 
    Calendar, 
    Plus, 
    Sparkles, 
    Lock, 
    Unlock, 
    ArrowUp, 
    ArrowDown, 
    Trash2, 
    MapPin, 
    ExternalLink, 
    Navigation, 
    Search, 
    Loader2, 
    Check, 
    FileText,
    BookOpen,
    Plane,
    Hotel,
    Ticket,
    Tag,
    Building2,
    Edit2,
    Undo2,
    Redo2,
    Train,
    Car,
    Compass
} from 'lucide-react';
import { toast } from 'sonner';
import { useTrek } from '../../contexts/TrekContext';
import { placeItemRepo, dayPlanRepo } from '../../services/db';
import { optimizeRouteWith2Opt, calculateTotalRouteDistance } from '../../services/map/tspService';
import { getOSRMRoute, getMultiLegRoute, getGoogleMapsRouteUrl } from '../../services/map/routeService';
import { sanitizeImageUrl, compressPlacePhoto } from '../../utils/imageSafety';
import { getDayNavigationLinks, getPlaceNavigationLinks } from '../../services/map/navigationLinks';
import { queryPublicTransitRoute } from '../../services/map/transitousService';
import { computeRoadTripSchedule } from '../../services/map/roadTripService';
import { createUndoManager } from '../../services/trips/undoRedoService';
import { searchPlaces, enrichPlaceWithWikipedia } from '../../services/places/placeSearchService';
import { getDayWeather } from '../../services/weather/weatherService';
import { extractRegionName, getCityDefaultCoordinates, AIRPORT_COORDINATES } from '../../utils/geoUtils';
import { STORAGE_KEYS } from '../../constants/storageKeys';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useI18n } from '../../i18n';
import { logger } from '../../utils/logger';

export default function DayPlanTimeline({ onSelectDayPlaces, onRouteCalculated, unifiedReservations = null }) {
    const { t } = useI18n();
    const { activeTrip, reservations = [], dayPlans, dataVersion = 0, refreshTrips } = useTrek();
    const activeReservations = unifiedReservations || reservations;
    const [selectedDayByTrip, setSelectedDayByTrip] = useLocalStorage(STORAGE_KEYS.PLANNER_SELECTED_DAY_BY_TRIP, {});
    const [dayPlacesMap, setDayPlacesMap] = useState({}); // { [dayIndex]: places[] }
    const [weatherMap, setWeatherMap] = useState({}); // { [dateStr]: weatherObj }
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [addPlaceTargetDayIndex, setAddPlaceTargetDayIndex] = useState(0);
    const [isOptimizing, setIsOptimizing] = useState(false);
    const [routeStats, setRouteStats] = useState(null);

    // Phase 1: IndexedDB-backed Undo/Redo Manager
    const undoManagerRef = useRef(null);
    if (!undoManagerRef.current) {
        undoManagerRef.current = createUndoManager(30);
    }
    const [undoState, setUndoState] = useState(() => undoManagerRef.current.getState());

    useEffect(() => {
        const unsub = undoManagerRef.current.subscribe(setUndoState);
        return unsub;
    }, []);

    // Phase 1: Road Trip Mode (off by default) & Public Transit
    const [roadTripEnabled, setRoadTripEnabled] = useState(false);
    const [roadTripStart, setRoadTripStart] = useState('09:00');
    const [roadTripEnd, setRoadTripEnd] = useState('18:00');
    const [roadTripDwell, setRoadTripDwell] = useState(45);
    const [transitResult, setTransitResult] = useState(null);
    const [isQueryingTransit, setIsQueryingTransit] = useState(false);
    const [openNavPlaceId, setOpenNavPlaceId] = useState(null);

    // 1. 根據旅程日期生成天數列表 (Day 1...Day N)
    const tripDays = useMemo(() => {
        const days = [];
        if (activeTrip && activeTrip.startDate && activeTrip.endDate) {
            const start = new Date(activeTrip.startDate);
            const end = new Date(activeTrip.endDate);
            let curr = new Date(start);
            let idx = 1;
            while (curr <= end) {
                days.push({
                    dayIndex: idx,
                    date: curr.toISOString().slice(0, 10)
                });
                curr.setDate(curr.getDate() + 1);
                idx++;
            }
        }
        if (days.length === 0) {
            const baseDate = activeTrip?.startDate || new Date().toISOString().slice(0, 10);
            days.push({ dayIndex: 1, date: baseDate });
        }
        return days;
    }, [activeTrip?.startDate, activeTrip?.endDate]);

    const rawSelectedDayIndex = activeTrip?.id ? (selectedDayByTrip?.[activeTrip.id] ?? 0) : 0;
    const selectedDayIndex = (tripDays.length > 0 && rawSelectedDayIndex >= 0 && rawSelectedDayIndex < tripDays.length)
        ? rawSelectedDayIndex
        : 0;

    const setSelectedDayIndex = useCallback((idxOrUpdater) => {
        if (!activeTrip?.id) return;
        setSelectedDayByTrip((prev) => {
            const current = prev?.[activeTrip.id] ?? 0;
            const next = typeof idxOrUpdater === 'function' ? idxOrUpdater(current) : idxOrUpdater;
            return { ...(prev || {}), [activeTrip.id]: next };
        });
    }, [activeTrip?.id, setSelectedDayByTrip]);

    // 景點修改狀態 (支援改名、備註、星等評分、安全自訂照片與更換所屬日程)
    const [editingPlace, setEditingPlace] = useState(null);
    const [editPlaceName, setEditPlaceName] = useState('');
    const [editPlaceAddress, setEditPlaceAddress] = useState('');
    const [editPlaceDayIndex, setEditPlaceDayIndex] = useState(0);
    const [editPlaceRating, setEditPlaceRating] = useState(0);
    const [editPlacePhotoUrl, setEditPlacePhotoUrl] = useState('');

    // Phase 5A: 原生 HTML5 拖曳排序與跨天拖放狀態
    const [draggedPlaceId, setDraggedPlaceId] = useState(null);
    const [dragOverDayIdx, setDragOverDayIdx] = useState(null);
    const [legStatsMap, setLegStatsMap] = useState({});

    const handleOpenEditPlace = (place) => {
        setEditingPlace(place);
        setEditPlaceName(place.name || '');
        setEditPlaceAddress(place.address || '');
        setEditPlaceDayIndex(place.dayIndex ?? selectedDayIndex);
        setEditPlaceRating(Number(place.rating) || 0);
        setEditPlacePhotoUrl(place.customPhotoUrl || '');
    };

    const handleUploadCustomPhoto = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const compressed = await compressPlacePhoto(file, 480, 0.75);
            setEditPlacePhotoUrl(compressed);
            toast.success('已壓縮並套用自訂景點照片');
        } catch (err) {
            toast.error(`圖片處理失敗：${err.message}`);
        } finally {
            e.target.value = '';
        }
    };

    const handleSaveEditPlace = async (e) => {
        e.preventDefault();
        if (!editingPlace || !editPlaceName.trim()) return;

        const safePhoto = editPlacePhotoUrl.trim() ? sanitizeImageUrl(editPlacePhotoUrl) : '';
        if (editPlacePhotoUrl.trim() && !safePhoto) {
            toast.error('圖片網址僅支援 https:// 或壓縮圖片格式');
            return;
        }

        const originDayIndex = editingPlace.dayIndex ?? selectedDayIndex;
        const targetDayIndex = Number(editPlaceDayIndex);
        const isDayChanged = targetDayIndex !== originDayIndex;

        const targetPlaces = dayPlacesMap[targetDayIndex] || [];
        const updated = {
            ...editingPlace,
            name: editPlaceName.trim(),
            address: editPlaceAddress.trim(),
            rating: Number(editPlaceRating) || 0,
            customPhotoUrl: safePhoto || null,
            dayIndex: targetDayIndex,
            orderIndex: isDayChanged ? targetPlaces.length : (editingPlace.orderIndex || 0)
        };

        await placeItemRepo.save(updated);

        setDayPlacesMap(prev => {
            if (isDayChanged) {
                const updatedOrigin = (prev[originDayIndex] || []).filter(p => p.id !== updated.id);
                const updatedTarget = [...(prev[targetDayIndex] || []), updated];
                return {
                    ...prev,
                    [originDayIndex]: updatedOrigin,
                    [targetDayIndex]: updatedTarget
                };
            } else {
                return {
                    ...prev,
                    [originDayIndex]: (prev[originDayIndex] || []).map(p => p.id === updated.id ? updated : p)
                };
            }
        });

        setEditingPlace(null);
        if (isDayChanged) {
            const targetDayInfo = tripDays[targetDayIndex];
            const dayLabel = targetDayInfo ? `Day ${targetDayInfo.dayIndex} (${targetDayInfo.date})` : `Day ${targetDayIndex + 1}`;
            toast.success(`已將「${updated.name}」移至 ${dayLabel}`);
        } else {
            toast.success(`已更新景點：${updated.name}`);
        }
    };

    // 快速換日（直接由卡片選取，支援 Ctrl+Z 復原）
    const handleQuickMoveDay = async (place, targetDayIndex) => {
        const originDayIndex = place.dayIndex ?? selectedDayIndex;
        if (targetDayIndex === originDayIndex) return;

        const targetPlaces = dayPlacesMap[targetDayIndex] || [];
        const beforePlace = { ...place, dayIndex: originDayIndex };
        const updated = {
            ...place,
            dayIndex: targetDayIndex,
            orderIndex: targetPlaces.length
        };

        await undoManagerRef.current.push({
            label: `跨天移動 (${place.name})`,
            execute: async () => {
                await placeItemRepo.save(updated);
                setDayPlacesMap((prev) => ({
                    ...prev,
                    [originDayIndex]: (prev[originDayIndex] || []).filter((p) => p.id !== place.id),
                    [targetDayIndex]: [...(prev[targetDayIndex] || []).filter((p) => p.id !== place.id), updated],
                }));
            },
            undo: async () => {
                await placeItemRepo.save(beforePlace);
                setDayPlacesMap((prev) => ({
                    ...prev,
                    [targetDayIndex]: (prev[targetDayIndex] || []).filter((p) => p.id !== place.id),
                    [originDayIndex]: [...(prev[originDayIndex] || []).filter((p) => p.id !== place.id), beforePlace]
                        .sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0)),
                }));
            },
        }, true);

        const targetDayInfo = tripDays[targetDayIndex];
        const dayLabel = targetDayInfo ? `Day ${targetDayInfo.dayIndex} (${targetDayInfo.date.slice(5)})` : `Day ${targetDayIndex + 1}`;
        toast.success(`已將「${place.name}」移至 ${dayLabel}（可按 Ctrl+Z 復原）`);
    };

    // 2. 載入景點資料
    useEffect(() => {
        if (!activeTrip) return;
        async function loadPlaces() {
            const allPlaces = await placeItemRepo.getByTrip(activeTrip.id);
            const mapping = {};
            tripDays.forEach((_, i) => { mapping[i] = []; });

            allPlaces.forEach(p => {
                const dayIdx = p.dayIndex ?? 0;
                if (!mapping[dayIdx]) mapping[dayIdx] = [];
                mapping[dayIdx].push(p);
            });

            // 依 orderIndex 排序
            Object.keys(mapping).forEach(k => {
                mapping[k].sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
            });

            setDayPlacesMap(mapping);
        }
        loadPlaces();
    }, [activeTrip?.id, dataVersion]);

    // 3. 當選中特定天時，將該天景點傳遞給父層地圖視窗
    useEffect(() => {
        const currentPlaces = dayPlacesMap[selectedDayIndex] || [];
        if (onSelectDayPlaces) {
            onSelectDayPlaces(currentPlaces);
        }
    }, [selectedDayIndex, dayPlacesMap, onSelectDayPlaces]);

    const activeDayPlaces = dayPlacesMap[selectedDayIndex] || [];
    const activeDayInfo = tripDays[selectedDayIndex] || { dayIndex: 1, date: activeTrip?.startDate };

    // ── 整合當日預訂 (機票、飯店、以及尚未轉入當日景點列表之活動) ──────────────────────────
    const dayReservations = useMemo(() => {
        if (!activeDayInfo?.date || !activeReservations || activeReservations.length === 0) return [];
        const dateStr = activeDayInfo.date;
        const placeNameSet = new Set((activeDayPlaces || []).map(p => (p.name || '').trim()));
        const placeIdSet = new Set((activeDayPlaces || []).flatMap(p => [p.id, p.activityId].filter(Boolean)));

        return activeReservations.filter(r => {
            if (r.type === 'flight') {
                const depDate = r.flightDetails?.departureTime?.slice(0, 10) || r.startDate?.slice(0, 10);
                const arrDate = r.flightDetails?.arrivalTime?.slice(0, 10) || r.endDate?.slice(0, 10);
                return depDate === dateStr || arrDate === dateStr;
            }
            if (r.type === 'hotel' || r.type === 'accommodation') {
                const checkIn = r.accommodationDetails?.checkInDate?.slice(0, 10) || r.startDate?.slice(0, 10);
                const checkOut = r.accommodationDetails?.checkOutDate?.slice(0, 10) || r.endDate?.slice(0, 10);
                if (checkIn === dateStr || checkOut === dateStr) return true;
                if (checkIn && checkOut && dateStr > checkIn && dateStr < checkOut) return true;
                return false;
            }
            // 若該活動已存在於下方當日景點排程列表 (activeDayPlaces)，不再重複顯示於頂部黑框
            if (
                (r.legacyId && (placeIdSet.has(r.legacyId) || placeIdSet.has(`place_${r.legacyId}`))) ||
                (r.title && placeNameSet.has(r.title.trim()))
            ) {
                return false;
            }
            const eventDate = r.activityDetails?.date?.slice(0, 10) || r.startDate?.slice(0, 10);
            return eventDate === dateStr;
        });
    }, [activeDayInfo?.date, activeReservations, activeDayPlaces]);

    // ── 計算當日天氣代表地區與坐標 ──────────────────────────
    const currentDayLocation = useMemo(() => {
        // 全球動態坐標回退解析：1. 旅程目的地/標題對應城市 2. 機票抵達機場坐標 3. 預設東京
        const dest = activeTrip?.destination || activeTrip?.title || '';
        let defaultCoords = getCityDefaultCoordinates(dest);

        if (!defaultCoords) {
            const flightRes = (activeReservations || []).find(r => r.type === 'flight');
            const arrCode = flightRes?.flightDetails?.arrivalAirport || flightRes?.flightDetails?.destinationAirport;
            if (arrCode && AIRPORT_COORDINATES[arrCode.toUpperCase()]) {
                defaultCoords = AIRPORT_COORDINATES[arrCode.toUpperCase()];
            }
        }
        if (!defaultCoords) {
            defaultCoords = { lat: 35.6812, lng: 139.7671 };
        }

        // 基礎地區標籤備援
        const fallbackRegion = activeTrip?.destination
            ? (activeTrip.destination.endsWith('區') || activeTrip.destination.endsWith('市') || activeTrip.destination.endsWith('都')
                ? activeTrip.destination
                : `${activeTrip.destination}市區`)
            : (activeTrip?.title?.includes('Tokyo') || activeTrip?.title?.includes('東京') ? '東京市區' : '當地市區');

        // 1. 若當天有景點：精準抓取景點坐標供微氣候 API 查詢，標籤「只顯示行政地區」避免與下方景點清單重複
        if (activeDayPlaces.length > 0) {
            const first = activeDayPlaces[0];
            // 優先從第一景點提取純地區（例如：澀谷區、臺東區、Manhattan、Camden），若無則嘗試從當日其餘景點提取
            let region = extractRegionName(first.address);
            if (!region) {
                const otherWithRegion = activeDayPlaces.find(p => p.address && extractRegionName(p.address));
                if (otherWithRegion) {
                    region = extractRegionName(otherWithRegion.address);
                }
            }

            return {
                lat: first.lat || defaultCoords.lat,
                lng: first.lng || defaultCoords.lng,
                label: region || fallbackRegion
            };
        }

        // 2. 當天無景點，次之檢查當天飯店住宿
        const hotelRes = dayReservations.find(r => r.type === 'hotel' || r.type === 'accommodation');
        if (hotelRes) {
            const hotelAddress = hotelRes.accommodationDetails?.address || hotelRes.address || '';
            const hotelRegion = extractRegionName(hotelAddress);
            return {
                lat: defaultCoords.lat,
                lng: defaultCoords.lng,
                label: hotelRegion || fallbackRegion
            };
        }

        // 3. 預設行程目的地或基準中心
        return {
            lat: defaultCoords.lat,
            lng: defaultCoords.lng,
            label: fallbackRegion
        };
    }, [activeDayPlaces, dayReservations, activeTrip, activeReservations]);

    // 4. 抓取當前選取日期的天氣預報 (依 currentDayLocation 動態查詢微氣候)
    useEffect(() => {
        const dayInfo = tripDays[selectedDayIndex];
        if (!dayInfo) return;
        const { lat, lng } = currentDayLocation;

        if (!weatherMap[dayInfo.date]) {
            getDayWeather(lat, lng, dayInfo.date).then(w => {
                if (w) setWeatherMap(prev => ({ ...prev, [dayInfo.date]: w }));
            });
        }
    }, [selectedDayIndex, tripDays, currentDayLocation, weatherMap]);

    const currentWeather = weatherMap[activeDayInfo.date];

    // ── 景點操作 ──────────────────────────────────────────────────────────

    const handleToggleLock = async (place) => {
        const updated = { ...place, isLocked: !place.isLocked };
        await placeItemRepo.save(updated);
        setDayPlacesMap(prev => ({
            ...prev,
            [selectedDayIndex]: prev[selectedDayIndex].map(p => p.id === place.id ? updated : p)
        }));
    };

    const handleUndo = useCallback(async () => {
        try {
            const cmd = await undoManagerRef.current.undo();
            if (cmd) toast.info(`${t('undo.undone', '已復原上一步操作')}：${cmd.label}`);
        } catch (err) {
            logger.error('Undo failed:', err);
            toast.error('復原操作失敗');
        }
    }, [t]);

    const handleRedo = useCallback(async () => {
        try {
            const cmd = await undoManagerRef.current.redo();
            if (cmd) toast.info(`${t('undo.redone', '已重做操作')}：${cmd.label}`);
        } catch (err) {
            logger.error('Redo failed:', err);
            toast.error('重做操作失敗');
        }
    }, [t]);

    // 快捷鍵支援 Ctrl/Cmd+Z 與 Ctrl/Cmd+Shift+Z
    useEffect(() => {
        const onKeyDown = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
                e.preventDefault();
                if (e.shiftKey) {
                    handleRedo();
                } else {
                    handleUndo();
                }
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [handleUndo, handleRedo]);

    const handleMoveOrder = async (index, direction) => {
        const targetIndex = index + direction;
        if (targetIndex < 0 || targetIndex >= activeDayPlaces.length) return;

        const dayIdx = selectedDayIndex;
        const beforeSnapshot = activeDayPlaces.map((p, idx) => ({ ...p, orderIndex: idx }));
        const updated = [...beforeSnapshot];
        const [moved] = updated.splice(index, 1);
        updated.splice(targetIndex, 0, moved);
        const afterSnapshot = updated.map((p, idx) => ({ ...p, orderIndex: idx }));

        await undoManagerRef.current.push({
            label: `調整順序 (${moved.name})`,
            execute: async () => {
                await placeItemRepo.saveBatch(afterSnapshot);
                setDayPlacesMap((prev) => ({ ...prev, [dayIdx]: afterSnapshot }));
            },
            undo: async () => {
                await placeItemRepo.saveBatch(beforeSnapshot);
                setDayPlacesMap((prev) => ({ ...prev, [dayIdx]: beforeSnapshot }));
            },
        }, true);
    };

    const handleDeletePlace = async (id) => {
        const dayIdx = selectedDayIndex;
        const target = activeDayPlaces.find((p) => p.id === id);
        if (!target) return;

        await undoManagerRef.current.push({
            label: `刪除景點 (${target.name})`,
            execute: async () => {
                await placeItemRepo.delete(id);
                setDayPlacesMap((prev) => ({
                    ...prev,
                    [dayIdx]: (prev[dayIdx] || []).filter((p) => p.id !== id),
                }));
            },
            undo: async () => {
                await placeItemRepo.save(target);
                setDayPlacesMap((prev) => {
                    const restored = [...(prev[dayIdx] || []), target].sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
                    return { ...prev, [dayIdx]: restored };
                });
            },
        }, true);
        toast.info(`景點「${target.name}」已移除（可按 Ctrl+Z 復原）`);
    };

    const handleQueryTransit = async () => {
        if (activeDayPlaces.length < 2) {
            toast.info('至少需要 2 個景點才能查詢大眾運輸路線');
            return;
        }
        setIsQueryingTransit(true);
        try {
            const maxLegs = Math.min(activeDayPlaces.length - 1, 10);
            const legPairs = [];
            for (let i = 0; i < maxLegs; i++) {
                legPairs.push({
                    legIndex: i + 1,
                    from: activeDayPlaces[i],
                    to: activeDayPlaces[i + 1],
                });
            }
            const results = await Promise.all(
                legPairs.map(async ({ legIndex, from, to }) => {
                    const res = await queryPublicTransitRoute(from, to);
                    return {
                        legIndex,
                        fromName: from.name || `站點 ${legIndex}`,
                        toName: to.name || `站點 ${legIndex + 1}`,
                        ...res,
                    };
                })
            );
            setTransitResult({
                totalLegs: results.length,
                truncated: activeDayPlaces.length - 1 > maxLegs,
                legs: results,
            });
        } finally {
            setIsQueryingTransit(false);
        }
    };

    const roadTripSchedule = useMemo(() => {
        if (!roadTripEnabled || activeDayPlaces.length === 0) return null;
        return computeRoadTripSchedule(activeDayPlaces, {
            dayStartTime: roadTripStart,
            dayEndTime: roadTripEnd,
            defaultDwellMin: Number(roadTripDwell) || 45,
        });
    }, [roadTripEnabled, activeDayPlaces, roadTripStart, roadTripEnd, roadTripDwell]);

    const dayNavLinks = useMemo(() => getDayNavigationLinks(activeDayPlaces, 'driving'), [activeDayPlaces]);

    // ── 智慧 2-opt TSP 排程最佳化 ──────────────────────────────────────────

    const handleOptimizeTSP = async () => {
        if (activeDayPlaces.length < 3) {
            toast.info('至少需要 3 個景點才能進行路徑最佳化');
            return;
        }

        setIsOptimizing(true);
        try {
            const dayIdx = selectedDayIndex;
            const beforeSnapshot = activeDayPlaces.map((p, idx) => ({ ...p, orderIndex: idx }));
            const { optimizedPlaces, improvedKm } = optimizeRouteWith2Opt(activeDayPlaces);
            const afterSnapshot = optimizedPlaces.map((p, idx) => ({ ...p, orderIndex: idx }));

            await undoManagerRef.current.push({
                label: '2-opt 智慧路徑最佳化',
                execute: async () => {
                    await placeItemRepo.saveBatch(afterSnapshot);
                    setDayPlacesMap((prev) => ({ ...prev, [dayIdx]: afterSnapshot }));
                },
                undo: async () => {
                    await placeItemRepo.saveBatch(beforeSnapshot);
                    setDayPlacesMap((prev) => ({ ...prev, [dayIdx]: beforeSnapshot }));
                },
            }, true);

            if (improvedKm > 0) {
                toast.success(`✨ 最佳化完成！預估減少 ${improvedKm} km 繞路距離（可按 Ctrl+Z 復原）`);
            } else {
                toast.success('當前順序已是最優路徑！');
            }

            // 自動觸發 OSRM 繪製路線
            handleCalculateOSRM(afterSnapshot);
        } catch (err) {
            logger.error('TSP optimization error:', err);
        } finally {
            setIsOptimizing(false);
        }
    };

    // Phase 5A.1: 拖曳景點卡片交換當日順序（支援 Undo/Redo 並清除舊路線快取）
    const handleDropOnPlace = async (targetIdx) => {
        if (!draggedPlaceId) return;
        const fromIdx = activeDayPlaces.findIndex((p) => p.id === draggedPlaceId);
        setDraggedPlaceId(null);
        if (fromIdx === -1 || fromIdx === targetIdx) return;

        const dayIdx = selectedDayIndex;
        const beforeSnapshot = activeDayPlaces.map((p, idx) => ({ ...p, orderIndex: idx }));
        const updated = [...beforeSnapshot];
        const [moved] = updated.splice(fromIdx, 1);
        updated.splice(targetIdx, 0, moved);
        const afterSnapshot = updated.map((p, idx) => ({ ...p, orderIndex: idx }));

        setRouteStats(null);
        setLegStatsMap({});
        if (onRouteCalculated) onRouteCalculated(null);

        await undoManagerRef.current.push({
            label: `拖曳排序 (${moved.name})`,
            execute: async () => {
                await placeItemRepo.saveBatch(afterSnapshot);
                setDayPlacesMap((prev) => ({ ...prev, [dayIdx]: afterSnapshot }));
            },
            undo: async () => {
                await placeItemRepo.saveBatch(beforeSnapshot);
                setDayPlacesMap((prev) => ({ ...prev, [dayIdx]: beforeSnapshot }));
            },
        }, true);
    };

    // Phase 5A.1: 拖曳景點卡片放至上方 Day N 分頁標籤直接跨天移動
    const handleDropOnDayTab = async (targetDayIndex) => {
        setDragOverDayIdx(null);
        if (!draggedPlaceId) return;
        const place = activeDayPlaces.find((p) => p.id === draggedPlaceId);
        setDraggedPlaceId(null);
        if (!place) return;
        setRouteStats(null);
        setLegStatsMap({});
        if (onRouteCalculated) onRouteCalculated(null);
        await handleQuickMoveDay(place, targetDayIndex);
    };

    // Phase 5A.2: 單段交通模式切換 ('driving' | 'walking' | 'cycling')
    const handleCycleLegMode = async (place) => {
        const modes = ['driving', 'walking', 'cycling'];
        const curIdx = modes.indexOf(place.travelModeToNext || 'driving');
        const nextMode = modes[(curIdx + 1) % modes.length];
        const updated = { ...place, travelModeToNext: nextMode };
        await placeItemRepo.save(updated);
        const nextList = activeDayPlaces.map((p) => (p.id === place.id ? updated : p));
        setDayPlacesMap((prev) => ({ ...prev, [selectedDayIndex]: nextList }));
        handleCalculateOSRM(nextList);
    };

    // ── OSRM 多段交通模式實際道路計算 ──────────────────────────────────────

    const handleCalculateOSRM = async (placesToRoute = activeDayPlaces) => {
        if (placesToRoute.length < 2) return;
        const hasCustomModes = placesToRoute.some((p) => p.travelModeToNext && p.travelModeToNext !== 'driving');
        const osrmResult = hasCustomModes
            ? await getMultiLegRoute(placesToRoute)
            : await getOSRMRoute(placesToRoute.map(p => ({ lat: p.lat, lng: p.lng })), 'driving');

        if (osrmResult) {
            setRouteStats({
                distanceKm: osrmResult.distanceKm,
                durationMinutes: osrmResult.durationMinutes
            });
            if (Array.isArray(osrmResult.legs)) {
                const map = {};
                osrmResult.legs.forEach((leg) => {
                    map[leg.fromId] = leg;
                });
                setLegStatsMap(map);
            } else {
                setLegStatsMap({});
            }
            if (onRouteCalculated) {
                onRouteCalculated(osrmResult.geometry);
            }
        }
    };

    // ── 地點搜尋與加入 ──────────────────────────────────────────────────────

    const handleSearch = async (e) => {
        e.preventDefault();
        if (!searchQuery.trim()) return;
        setIsSearching(true);
        const results = await searchPlaces(searchQuery);
        setSearchResults(results);
        setIsSearching(false);
    };

    const handleAddPlace = async (result) => {
        // 富化維基百科介紹
        const enrichment = await enrichPlaceWithWikipedia(result.name);
        const targetDay = Number(addPlaceTargetDayIndex);
        const targetPlaces = dayPlacesMap[targetDay] || [];

        const newPlace = {
            id: `place_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            tripId: activeTrip.id,
            dayIndex: targetDay,
            name: result.name,
            lat: result.lat,
            lng: result.lng,
            address: result.address,
            orderIndex: targetPlaces.length,
            isLocked: false,
            enrichment: enrichment || null,
            createdAt: Date.now()
        };

        await placeItemRepo.save(newPlace);
        setDayPlacesMap(prev => ({
            ...prev,
            [targetDay]: [...(prev[targetDay] || []), newPlace]
        }));

        const targetDayInfo = tripDays[targetDay];
        const dayLabel = targetDayInfo ? `Day ${targetDayInfo.dayIndex} (${targetDayInfo.date})` : `Day ${targetDay + 1}`;
        toast.success(`已將「${newPlace.name}」排入 ${dayLabel}`);
        setIsAddModalOpen(false);
        setSearchQuery('');
        setSearchResults([]);
    };

    return (
        <div className="space-y-4">
            {/* 1. 每日標籤橫向滑動列 (支援拖曳景點卡片直接放上 Day 標籤換日) */}
            <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
                {tripDays.map((day, idx) => (
                    <button
                        key={day.date}
                        onClick={() => { setSelectedDayIndex(idx); setRouteStats(null); setLegStatsMap({}); }}
                        onDragOver={(e) => { e.preventDefault(); setDragOverDayIdx(idx); }}
                        onDragLeave={() => setDragOverDayIdx(null)}
                        onDrop={(e) => { e.preventDefault(); handleDropOnDayTab(idx); }}
                        className={`px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition flex items-center gap-1.5 ${
                            dragOverDayIdx === idx
                                ? 'bg-emerald-600 text-white ring-2 ring-emerald-300 scale-105'
                                : selectedDayIndex === idx
                                    ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
                                    : 'bg-white text-slate-600 hover:bg-slate-100 border border-gray-200'
                        }`}
                    >
                        <span>Day {day.dayIndex}</span>
                        <span className="text-[10px] opacity-70">({day.date.slice(5)})</span>
                    </button>
                ))}
            </div>

            {/* 2. 當日頂部卡片：日期與天氣預報 */}
            <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h3 className="text-base font-black text-slate-800 flex items-center gap-2">
                        <span>Day {activeDayInfo.dayIndex} 行程</span>
                        <span className="text-xs font-normal text-slate-400">({activeDayInfo.date})</span>
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                        共 {activeDayPlaces.length} 個行程停靠點
                        {routeStats && (
                            <span className="ml-2 font-bold text-indigo-600">
                                · 🚗 全程約 {routeStats.distanceKm} km (車程約 {routeStats.durationMinutes} 分鐘)
                            </span>
                        )}
                    </p>
                </div>

                {/* 天氣預報 Badge (優化視覺階層與標籤呈現) */}
                {currentWeather ? (() => {
                    const cleanDesc = (currentWeather.condition || currentWeather.desc || '晴朗').replace(/\s*\(歷年氣候預估\)/, '');
                    return (
                        <div className="flex items-center gap-3 bg-gradient-to-br from-sky-50/90 via-sky-50/50 to-blue-50/30 border border-sky-100/90 px-3.5 py-2 rounded-2xl shadow-2xs">
                            <span className="text-2xl shrink-0 select-none filter drop-shadow-xs">{currentWeather.icon}</span>
                            <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap leading-tight">
                                    <span className="text-xs font-black text-slate-800 tracking-tight">
                                        {cleanDesc}
                                    </span>
                                    {currentWeather.isHistoricalEstimate ? (
                                        <span className="text-[10px] font-semibold bg-amber-100/80 text-amber-700 px-1.5 py-0.2 rounded border border-amber-200/50 shrink-0">
                                            歷年預估
                                        </span>
                                    ) : (
                                        <span className="text-[10px] font-semibold bg-emerald-100/80 text-emerald-700 px-1.5 py-0.2 rounded border border-emerald-200/50 shrink-0">
                                            即時預報
                                        </span>
                                    )}
                                    {currentDayLocation.label && (
                                        <span className="text-[10px] font-bold bg-white text-sky-700 px-1.5 py-0.2 rounded border border-sky-200/60 shadow-2xs flex items-center gap-0.5 shrink-0">
                                            <MapPin className="w-2.5 h-2.5 shrink-0 text-sky-500" />
                                            <span>{currentDayLocation.label}</span>
                                        </span>
                                    )}
                                </div>
                                <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-2 font-mono">
                                    <span className="font-semibold text-slate-700">
                                        {currentWeather.tempMin}°C ~ {currentWeather.tempMax}°C
                                    </span>
                                    <span className="text-slate-300">·</span>
                                    <span className={currentWeather.rainProb >= 40 ? 'text-blue-600 font-bold' : 'text-slate-500'}>
                                        💧 降雨 {currentWeather.rainProb}%
                                    </span>
                                </div>
                            </div>
                        </div>
                    );
                })() : (
                    <div className="text-xs text-slate-400 bg-slate-50 px-3 py-2 rounded-xl border border-dashed border-slate-200">
                        載入天氣中...
                    </div>
                )}
            </div>

            {/* 2.5 當日交通、住宿與活動整合時序卡片 */}
            {dayReservations.length > 0 ? (
                <div className="bg-slate-900 text-white rounded-xl p-3.5 shadow-sm space-y-2.5">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                            <Plane className="w-3.5 h-3.5 text-indigo-400" />
                            <span>當日交通與住宿排程 ({dayReservations.length})</span>
                        </span>
                        <span className="text-[10px] text-slate-400 font-medium">已自動整合至時間表</span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {dayReservations.map(res => {
                            const isFlight = res.type === 'flight';
                            const isHotel = res.type === 'hotel' || res.type === 'accommodation';
                            const checkIn = res.accommodationDetails?.checkInDate?.slice(0, 10);
                            const checkOut = res.accommodationDetails?.checkOutDate?.slice(0, 10);
                            const isCheckInDay = checkIn === activeDayInfo.date;
                            const isCheckOutDay = checkOut === activeDayInfo.date;

                            return (
                                <div 
                                    key={res.id} 
                                    className="bg-slate-800/90 border border-slate-700/80 rounded-lg p-2.5 flex items-start gap-2.5 hover:bg-slate-800 transition"
                                >
                                    <div className="p-1.5 rounded-md bg-indigo-500/20 text-indigo-300 shrink-0 mt-0.5">
                                        {isFlight ? <Plane className="w-4 h-4" /> : isHotel ? <Hotel className="w-4 h-4" /> : <Ticket className="w-4 h-4" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-1">
                                            <span className="text-xs font-bold text-white truncate">
                                                {isFlight 
                                                    ? `${res.flightDetails?.airline || ''} ${res.flightDetails?.flightNumber || res.title}`
                                                    : isHotel 
                                                        ? (res.accommodationDetails?.hotelName || res.title)
                                                        : res.title
                                                }
                                            </span>
                                            {isHotel && (
                                                <span className={`text-[10px] px-1.5 py-0.2 rounded font-bold shrink-0 ${
                                                    isCheckInDay ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                                                    isCheckOutDay ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' :
                                                    'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                                }`}>
                                                    {isCheckInDay ? '辦理入住' : isCheckOutDay ? '辦理退房' : '住宿中'}
                                                </span>
                                            )}
                                            {isFlight && res.confirmationCode && (
                                                <span className="text-[10px] font-mono bg-indigo-500/30 text-indigo-200 px-1 rounded shrink-0">
                                                    {res.confirmationCode}
                                                </span>
                                            )}
                                        </div>

                                        {isFlight && (
                                            <div className="text-[11px] text-slate-300 mt-1 flex items-center gap-1.5">
                                                <span className="font-semibold text-indigo-300">
                                                    {res.flightDetails?.from || '出發站'} ➔ {res.flightDetails?.to || '抵達站'}
                                                </span>
                                                {(res.flightDetails?.departureTime || res.flightDetails?.arrivalTime) && (
                                                    <span className="text-slate-400 text-[10px]">
                                                        {res.flightDetails?.departureTime ? res.flightDetails.departureTime.slice(11, 16) : ''}
                                                        {res.flightDetails?.arrivalTime ? ` ~ ${res.flightDetails.arrivalTime.slice(11, 16)}` : ''}
                                                    </span>
                                                )}
                                            </div>
                                        )}

                                        {isHotel && (
                                            <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                                                {res.accommodationDetails?.address || res.notes || '已確認預約'}
                                            </div>
                                        )}

                                        {!isFlight && !isHotel && (
                                            <div className="text-[11px] text-slate-400 mt-0.5">
                                                {res.activityDetails?.location || res.notes || '票券憑證'}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            {/* 3. 工具列：Undo/Redo、智慧最佳化、大眾運輸、公路旅行模式、外部導航 */}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                    <button
                        type="button"
                        onClick={handleUndo}
                        disabled={!undoState.canUndo}
                        className="px-2 py-1.5 bg-white hover:bg-slate-50 border border-gray-200 text-slate-700 rounded-lg text-xs font-bold transition flex items-center gap-1 disabled:opacity-40"
                        title={undoState.undoLabel ? `${t('undo.undo', '復原')}: ${undoState.undoLabel} (Ctrl+Z)` : `${t('undo.undo', '復原')} (Ctrl+Z)`}
                    >
                        <Undo2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={handleRedo}
                        disabled={!undoState.canRedo}
                        className="px-2 py-1.5 bg-white hover:bg-slate-50 border border-gray-200 text-slate-700 rounded-lg text-xs font-bold transition flex items-center gap-1 disabled:opacity-40"
                        title={undoState.redoLabel ? `${t('undo.redo', '重做')}: ${undoState.redoLabel} (Ctrl+Shift+Z)` : `${t('undo.redo', '重做')} (Ctrl+Shift+Z)`}
                    >
                        <Redo2 className="w-3.5 h-3.5" />
                    </button>

                    <button
                        onClick={handleOptimizeTSP}
                        disabled={isOptimizing || activeDayPlaces.length < 3}
                        className="px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-lg text-xs font-bold shadow-sm transition flex items-center gap-1.5 disabled:opacity-50"
                        title="透過 2-opt 演算法重排未鎖定之景點，最小化繞路距離"
                    >
                        <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                        <span>智慧最佳化 (2-opt)</span>
                    </button>

                    <button
                        onClick={() => handleCalculateOSRM()}
                        disabled={activeDayPlaces.length < 2}
                        className="px-2.5 py-1.5 bg-white hover:bg-slate-50 border border-gray-200 text-slate-700 rounded-lg text-xs font-bold transition flex items-center gap-1 disabled:opacity-50"
                    >
                        <Navigation className="w-3.5 h-3.5 text-indigo-600" />
                        <span>繪製路線</span>
                    </button>

                    <button
                        type="button"
                        onClick={handleQueryTransit}
                        disabled={isQueryingTransit || activeDayPlaces.length < 2}
                        className="px-2.5 py-1.5 bg-white hover:bg-sky-50 border border-sky-200 text-sky-700 rounded-lg text-xs font-bold transition flex items-center gap-1 disabled:opacity-50"
                        title="透過免費 Transitous 查詢首站至末站大眾運輸轉乘"
                    >
                        {isQueryingTransit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Train className="w-3.5 h-3.5" />}
                        <span>{t('transit.title', '大眾運輸')}</span>
                    </button>

                    <button
                        type="button"
                        onClick={() => setRoadTripEnabled((v) => !v)}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 border ${
                            roadTripEnabled
                                ? 'bg-amber-600 text-white border-amber-600'
                                : 'bg-white hover:bg-amber-50 border-gray-200 text-slate-600'
                        }`}
                        title="選用開關：計算自駕行車時段與抵達時間"
                    >
                        <Car className="w-3.5 h-3.5" />
                        <span>{t('roadtrip.title', '公路旅行')}</span>
                    </button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                    {activeDayPlaces.length > 0 && (
                        <>
                            <a
                                href={dayNavLinks.googleMapsUrl || getGoogleMapsRouteUrl(activeDayPlaces)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2.5 py-1.5 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 rounded-lg text-xs font-bold transition flex items-center gap-1"
                            >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>Google Maps</span>
                            </a>
                            {dayNavLinks.coMapsUrl && (
                                <a
                                    href={dayNavLinks.coMapsUrl}
                                    className="px-2.5 py-1.5 bg-teal-50 hover:bg-teal-100 border border-teal-200 text-teal-700 rounded-lg text-xs font-bold transition flex items-center gap-1"
                                    title="在 CoMaps 開啟當日路線"
                                >
                                    <Compass className="w-3.5 h-3.5" />
                                    <span>CoMaps</span>
                                </a>
                            )}
                        </>
                    )}

                    <button
                        onClick={() => {
                            setAddPlaceTargetDayIndex(selectedDayIndex);
                            setIsAddModalOpen(true);
                        }}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold shadow-sm transition flex items-center gap-1"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        <span>加入景點</span>
                    </button>
                </div>
            </div>

            {/* 3.2 Road Trip 公路旅行模式設定與警示列 (預設關閉) */}
            {roadTripEnabled && (
                <div className="bg-amber-50/80 border border-amber-200 rounded-xl p-3 text-xs space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-extrabold text-amber-900 flex items-center gap-1.5">
                            <Car className="w-4 h-4 text-amber-600" />
                            <span>{t('roadtrip.title', '公路旅行模式')}</span>
                        </span>
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                            <label className="flex items-center gap-1 text-amber-900 font-semibold">
                                出發 <input type="time" value={roadTripStart} onChange={(e) => setRoadTripStart(e.target.value)} className="border border-amber-300 rounded px-1.5 py-0.5 bg-white" />
                            </label>
                            <label className="flex items-center gap-1 text-amber-900 font-semibold">
                                結束 <input type="time" value={roadTripEnd} onChange={(e) => setRoadTripEnd(e.target.value)} className="border border-amber-300 rounded px-1.5 py-0.5 bg-white" />
                            </label>
                            <label className="flex items-center gap-1 text-amber-900 font-semibold">
                                停留(分) <input type="number" min="0" max="480" value={roadTripDwell} onChange={(e) => setRoadTripDwell(e.target.value)} className="w-14 border border-amber-300 rounded px-1.5 py-0.5 bg-white" />
                            </label>
                        </div>
                    </div>
                    {roadTripSchedule && (
                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-amber-900">
                            <span>預估總自駕：<strong>{roadTripSchedule.totalDistanceKm} km</strong> · <strong>{roadTripSchedule.totalDriveMin} 分鐘</strong></span>
                            {roadTripSchedule.hasOverrun && (
                                <span className="px-2 py-0.5 rounded bg-rose-600 text-white font-bold">
                                    ⚠️ {t('roadtrip.overrun', '超出當日行車時段')} ({roadTripSchedule.windowEnd})
                                </span>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* 3.3 Transitous 逐段大眾運輸規劃結果卡片 (1➔2➔3...N) */}
            {transitResult && Array.isArray(transitResult.legs) && (
                <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 text-xs space-y-2.5">
                    <div className="flex items-center justify-between border-b border-sky-200/70 pb-2">
                        <span className="font-extrabold text-sky-900 flex items-center gap-1.5">
                            <Train className="w-4 h-4 text-sky-600" />
                            <span>當日逐段大眾運輸規劃（共 {transitResult.totalLegs} 段接駁）</span>
                        </span>
                        <button type="button" onClick={() => setTransitResult(null)} className="text-sky-500 hover:text-sky-800 font-bold text-sm leading-none">&times;</button>
                    </div>

                    <div className="space-y-2">
                        {transitResult.legs.map((legRes) => (
                            <div key={legRes.legIndex} className="bg-white rounded-lg p-2.5 border border-sky-100 space-y-1.5">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="font-extrabold text-slate-800 flex items-center gap-1.5 min-w-0">
                                        <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 font-mono text-[10px] shrink-0">
                                            {legRes.legIndex} ➔ {legRes.legIndex + 1}
                                        </span>
                                        <span className="truncate">{legRes.fromName} ➔ {legRes.toName}</span>
                                    </div>
                                    {legRes.fallbackUrl && (
                                        <a
                                            href={legRes.fallbackUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="px-2 py-0.5 bg-sky-600 text-white rounded-md text-[11px] font-bold hover:bg-sky-700 shrink-0"
                                        >
                                            Google 大眾運輸
                                        </a>
                                    )}
                                </div>

                                {legRes.ok && legRes.itineraries?.length > 0 ? (
                                    <div className="space-y-1">
                                        {legRes.itineraries.slice(0, 2).map((it, i) => (
                                            <div key={i} className="bg-sky-50/60 rounded p-1.5 flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                                                <span className="font-bold text-slate-700">
                                                    方案 {i + 1}：約 {it.durationMin} 分 · 轉乘 {it.transfers} 次
                                                </span>
                                                <div className="flex flex-wrap gap-1 text-[10px]">
                                                    {it.legs.map((sub, li) => (
                                                        <span key={li} className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 font-semibold">
                                                            {sub.mode}{sub.routeShortName ? ` ${sub.routeShortName}` : ''} ({sub.durationMin}m)
                                                        </span>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-[11px] text-slate-500">
                                        {t('transit.fallback', '查無即時轉乘資料，可點擊右側按鈕於 Google Maps 開啟此段大眾運輸')}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 4. 景點列表 (依 orderIndex 排序) */}
            <div className="space-y-2.5">
                {activeDayPlaces.length === 0 ? (
                    <div className="bg-white rounded-xl p-8 text-center text-slate-400 border border-gray-200 border-dashed">
                        <MapPin className="w-10 h-10 mx-auto mb-2 text-slate-300" />
                        <p className="text-sm font-semibold">這一天尚未安排任何景點</p>
                        <p className="text-xs text-slate-400 mt-1">點擊上方「加入景點」以搜尋並排入行程</p>
                    </div>
                ) : (
                    activeDayPlaces.map((place, idx) => {
                        const rtStop = roadTripSchedule?.stops?.[idx];
                        const navLinks = getPlaceNavigationLinks(place);
                        const legMode = place.travelModeToNext || 'driving';
                        const legStat = legStatsMap[place.id];
                        const modeBadge = legMode === 'walking' ? '🚶 步行' : legMode === 'cycling' ? '🚲 單車' : '🚗 開車';
                        return (
                        <React.Fragment key={place.id}>
                        <div
                            draggable
                            onDragStart={() => setDraggedPlaceId(place.id)}
                            onDragEnd={() => { setDraggedPlaceId(null); setDragOverDayIdx(null); }}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => { e.preventDefault(); handleDropOnPlace(idx); }}
                            className={`bg-white rounded-xl p-3.5 border transition-all shadow-sm flex items-start justify-between gap-3 cursor-grab active:cursor-grabbing ${
                                draggedPlaceId === place.id
                                    ? 'opacity-50 ring-2 ring-indigo-400'
                                    : rtStop?.exceedsWindow
                                        ? 'border-rose-300 bg-rose-50/30'
                                        : place.isLocked
                                            ? 'border-amber-200 bg-amber-50/20'
                                            : 'border-gray-200'
                            }`}
                        >
                            <div className="flex items-start gap-3 flex-1 min-w-0">
                                {/* 景點序號 */}
                                <div className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-black shrink-0 mt-0.5">
                                    {idx + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {rtStop && (
                                            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${rtStop.exceedsWindow ? 'bg-rose-600 text-white' : 'bg-amber-100 text-amber-800'}`}>
                                                🚗 {rtStop.arrivalTime}{rtStop.dwellMin > 0 ? `–${rtStop.departureTime}` : ''}
                                            </span>
                                        )}
                                        {navLinks.length > 0 && (
                                            <div className="relative inline-block">
                                                <button
                                                    type="button"
                                                    onClick={() => setOpenNavPlaceId((prev) => (prev === place.id ? null : place.id))}
                                                    className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-100 hover:bg-indigo-100 text-slate-600 hover:text-indigo-700 flex items-center gap-0.5"
                                                    title="開啟 7 款導航 App"
                                                >
                                                    <Compass className="w-3 h-3" />
                                                    <span>{t('map.openInNav', '導航')}</span>
                                                </button>
                                                {openNavPlaceId === place.id && (
                                                    <div className="absolute left-0 top-6 z-30 bg-white border border-slate-200 rounded-lg shadow-xl p-1.5 w-36 space-y-0.5">
                                                        {navLinks.map((lnk) => (
                                                            <a
                                                                key={lnk.id}
                                                                href={lnk.url}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                onClick={() => setOpenNavPlaceId(null)}
                                                                className="block px-2 py-1 rounded text-[11px] font-semibold text-slate-700 hover:bg-indigo-50 hover:text-indigo-700"
                                                            >
                                                                {lnk.label}
                                                            </a>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {place.time && (
                                            <span className="text-[11px] font-mono font-bold bg-indigo-50 text-indigo-700 border border-indigo-200/80 px-1.5 py-0.5 rounded shrink-0">
                                                {place.time}
                                            </span>
                                        )}
                                        <span className="font-bold text-sm text-slate-800 truncate">{place.name}</span>
                                        {place.isLocked && (
                                            <span className="text-[10px] bg-amber-100 text-amber-800 font-bold px-1.5 py-0.2 rounded flex items-center gap-0.5">
                                                <Lock className="w-2.5 h-2.5" /> 鎖定
                                            </span>
                                        )}
                                    </div>
                                    {place.address && (
                                        <p className="text-xs text-slate-500 truncate mt-0.5">📍 {place.address}</p>
                                    )}
                                    {place.notes && (
                                        <p className="text-xs text-slate-500 mt-1.5 bg-slate-50 p-2 rounded-lg border border-slate-100 leading-relaxed">
                                            {place.notes}
                                        </p>
                                    )}

                                    {/* 維基百科富化簡介 */}
                                    {place.enrichment?.description && (
                                        <div className="mt-2 text-xs text-slate-600 bg-slate-50 p-2 rounded-lg border border-slate-100 flex items-start gap-2">
                                            {place.enrichment.thumbnailUrl && (
                                                <img 
                                                    src={place.enrichment.thumbnailUrl} 
                                                    alt={place.name}
                                                    className="w-12 h-12 object-cover rounded shrink-0" 
                                                />
                                            )}
                                            <p className="line-clamp-2 leading-relaxed text-[11px] text-slate-500">
                                                {place.enrichment.description}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* 景點右側操作按鈕 */}
                            <div className="flex items-center gap-1.5 shrink-0">
                                {/* 快速更換所屬日程 */}
                                {tripDays.length > 1 && (
                                    <div className="relative flex items-center">
                                        <select
                                            value={place.dayIndex ?? selectedDayIndex}
                                            onChange={(e) => handleQuickMoveDay(place, Number(e.target.value))}
                                            className="text-[11px] bg-slate-50 hover:bg-indigo-50/70 hover:text-indigo-600 text-slate-600 font-bold border border-gray-200 rounded-lg px-2 py-1.5 cursor-pointer transition focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                            title="更換日程（快速移動至其他天）"
                                        >
                                            {tripDays.map((d, dIdx) => (
                                                <option key={d.date} value={dIdx}>
                                                    移至 Day {d.dayIndex} ({d.date.slice(5)})
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}

                                <button
                                    onClick={() => handleToggleLock(place)}
                                    title={place.isLocked ? '解鎖排序' : '鎖定此位置 (最佳化時不調動)'}
                                    className={`p-1.5 rounded-lg border transition ${
                                        place.isLocked ? 'bg-amber-100 text-amber-700 border-amber-300' : 'text-slate-400 hover:bg-slate-100 border-gray-200'
                                    }`}
                                >
                                    {place.isLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                                </button>
                                <button
                                    onClick={() => handleMoveOrder(idx, -1)}
                                    disabled={idx === 0}
                                    className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 border border-gray-200 rounded-lg disabled:opacity-30"
                                >
                                    <ArrowUp className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => handleMoveOrder(idx, 1)}
                                    disabled={idx === activeDayPlaces.length - 1}
                                    className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 border border-gray-200 rounded-lg disabled:opacity-30"
                                >
                                    <ArrowDown className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => handleOpenEditPlace(place)}
                                    title="修改景點資訊與更換日程"
                                    className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 border border-gray-200 rounded-lg transition"
                                >
                                    <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={() => handleDeletePlace(place.id)}
                                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 border border-gray-200 rounded-lg"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                        {idx < activeDayPlaces.length - 1 && (
                            <div className="flex items-center justify-center py-0.5">
                                <button
                                    type="button"
                                    onClick={() => handleCycleLegMode(place)}
                                    className="px-2.5 py-0.5 rounded-full bg-slate-100 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-200 text-[10px] font-bold text-slate-600 hover:text-indigo-700 transition flex items-center gap-1.5"
                                    title="點擊切換此段交通模式（開車 / 步行 / 單車）"
                                >
                                    <span>{modeBadge}</span>
                                    {legStat && (
                                        <span className="font-mono text-indigo-600">
                                            · {legStat.distanceKm} km / {legStat.durationMinutes} 分{legStat.estimated ? ' (估)' : ''}
                                        </span>
                                    )}
                                </button>
                            </div>
                        )}
                        </React.Fragment>
                        );
                    })
                )}
            </div>

            {/* 5. 新增景點 Modal (Nominatim 搜尋 + 即時維基圖文) */}
            {isAddModalOpen && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl text-slate-800 animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="font-bold text-base flex items-center gap-2">
                                <MapPin className="w-5 h-5 text-indigo-600" /> 加入景點
                            </h3>
                            <button onClick={() => setIsAddModalOpen(false)} className="text-slate-400 hover:text-slate-600">&times;</button>
                        </div>

                        {tripDays.length > 0 && (
                            <div className="flex items-center gap-2 mb-3 bg-indigo-50/60 p-2.5 rounded-xl border border-indigo-100 text-xs">
                                <Calendar className="w-4 h-4 text-indigo-600 shrink-0" />
                                <span className="font-bold text-slate-700 shrink-0">加入至日程：</span>
                                <select
                                    value={addPlaceTargetDayIndex}
                                    onChange={(e) => setAddPlaceTargetDayIndex(Number(e.target.value))}
                                    className="flex-1 bg-white border border-gray-300 rounded-lg px-2.5 py-1 text-xs font-bold text-slate-700 focus:outline-none focus:border-indigo-500"
                                >
                                    {tripDays.map((d, dIdx) => (
                                        <option key={d.date} value={dIdx}>
                                            Day {d.dayIndex} ({d.date})
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <form onSubmit={handleSearch} className="flex gap-2 mb-4">
                            <input
                                type="text"
                                placeholder="輸入景點、餐廳或地名 (例如: 東京鐵塔, 淺草寺)"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="flex-1 border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                                autoFocus
                            />
                            <button
                                type="submit"
                                disabled={isSearching}
                                className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-500 transition flex items-center gap-1"
                            >
                                {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                                <span>搜尋</span>
                            </button>
                        </form>

                        <div className="max-h-72 overflow-y-auto space-y-2">
                            {searchResults.length === 0 && !isSearching && (
                                <p className="text-xs text-slate-400 text-center py-6">請輸入關鍵字搜尋 OpenStreetMap 開放圖資</p>
                            )}
                            {searchResults.map((res) => (
                                <div
                                    key={res.id}
                                    onClick={() => handleAddPlace(res)}
                                    className="p-3 rounded-xl border border-gray-200 hover:border-indigo-500 hover:bg-indigo-50/30 cursor-pointer transition flex items-center justify-between gap-3"
                                >
                                    <div className="truncate">
                                        <div className="font-bold text-sm text-slate-800">{res.name}</div>
                                        <div className="text-xs text-slate-400 truncate">{res.address}</div>
                                    </div>
                                    <button className="px-3 py-1 bg-indigo-600 text-white text-xs font-bold rounded-lg shrink-0">
                                        加入
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* 6. 修改景點 Modal (支援改名、備註與更換所屬日程) */}
            {editingPlace && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl text-slate-800 animate-in fade-in zoom-in-95 duration-150">
                        <div className="flex items-center justify-between mb-4 border-b border-gray-100 pb-3">
                            <h3 className="font-bold text-base flex items-center gap-2">
                                <Edit2 className="w-4 h-4 text-indigo-600" />
                                <span>修改景點資訊</span>
                            </h3>
                            <button
                                onClick={() => setEditingPlace(null)}
                                className="text-slate-400 hover:text-slate-600 text-lg leading-none"
                            >
                                &times;
                            </button>
                        </div>
                        <form onSubmit={handleSaveEditPlace} className="space-y-3.5">
                            <div>
                                <label className="block text-xs font-bold text-slate-700 mb-1 flex items-center gap-1">
                                    <Calendar className="w-3.5 h-3.5 text-indigo-600" />
                                    <span>所屬日程 (更換日期)</span>
                                </label>
                                <select
                                    value={editPlaceDayIndex}
                                    onChange={(e) => setEditPlaceDayIndex(Number(e.target.value))}
                                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm font-semibold text-slate-700 focus:outline-none focus:border-indigo-500 bg-white"
                                >
                                    {tripDays.map((d, dIdx) => (
                                        <option key={d.date} value={dIdx}>
                                            Day {d.dayIndex} ({d.date})
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-700 mb-1">景點名稱</label>
                                <input
                                    type="text"
                                    required
                                    value={editPlaceName}
                                    onChange={(e) => setEditPlaceName(e.target.value)}
                                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-700 mb-1">地址 / 備註資訊</label>
                                <textarea
                                    rows="2"
                                    value={editPlaceAddress}
                                    onChange={(e) => setEditPlaceAddress(e.target.value)}
                                    className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 mb-1">景點評分 (1–5★)</label>
                                    <div className="flex items-center gap-1 pt-1">
                                        {[1, 2, 3, 4, 5].map((star) => (
                                            <button
                                                key={star}
                                                type="button"
                                                onClick={() => setEditPlaceRating(editPlaceRating === star ? 0 : star)}
                                                className={`text-lg leading-none transition ${star <= editPlaceRating ? 'text-amber-400 scale-110' : 'text-slate-300 hover:text-amber-300'}`}
                                            >
                                                ★
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-700 mb-1">自訂照片 (壓縮上傳)</label>
                                    <label className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-indigo-50 border border-slate-200 text-[11px] font-bold text-slate-700 cursor-pointer">
                                        <span>📷 選擇照片</span>
                                        <input type="file" accept="image/*" className="hidden" onChange={handleUploadCustomPhoto} />
                                    </label>
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-700 mb-1">自訂照片網址 (僅限 https://)</label>
                                <input
                                    type="text"
                                    placeholder="https://..."
                                    value={editPlacePhotoUrl}
                                    onChange={(e) => setEditPlacePhotoUrl(e.target.value)}
                                    className="w-full border border-gray-300 rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-indigo-500"
                                />
                            </div>
                            <div className="flex justify-end gap-2 pt-3 border-t border-gray-100">
                                <button
                                    type="button"
                                    onClick={() => setEditingPlace(null)}
                                    className="px-4 py-2 text-xs font-bold text-slate-500 hover:bg-slate-100 rounded-xl transition"
                                >
                                    取消
                                </button>
                                <button
                                    type="submit"
                                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-xl shadow-sm transition"
                                >
                                    儲存修改
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
