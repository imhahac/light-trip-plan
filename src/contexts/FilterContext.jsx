import React, { createContext, useContext, useMemo } from 'react';
import { useUIContext } from './UIContext';
import { useOptionalTrek } from './TrekContext';
import {
    useActivityDataContext,
    useHotelDataContext,
    useOverrideDataContext,
    useTicketDataContext,
} from './DataContext';
import { useFilteredItems } from '../hooks/useFilteredItems';
import { useDecoratedTrips } from '../hooks/useDecoratedTrips';
import { useItinerary, buildReadableTripLabel } from '../hooks/useItinerary';
import { applyTripOverrides } from '../utils/tripOverrides';
import { isDateOverlap } from '../services/reservations/unifiedReservationService';
import { isTripArchivedOrEnded } from '../services/trips/tripStatusService';

const FilterContext = createContext();

export function FilterProvider({ children }) {
    const { searchTerm, filterStatus, ticketScope = 'trip', selectedTripIdForMap } = useUIContext();
    const { activeTrip, trips: trekTrips = [], isSharedView, sharedTripData } = useOptionalTrek();
    const { tickets, tripLabels, trips } = useTicketDataContext();
    const { rawHotels } = useHotelDataContext();
    const { activities } = useActivityDataContext();
    const { tripOverrides } = useOverrideDataContext();

    // 1. 應用手動重組 (Overrides)
    const displayTrips = useMemo(() => applyTripOverrides(trips, tripOverrides), [trips, tripOverrides]);

    // 2. 裝飾行程 (計算費用、安全性檢查)
    const {
        decoratedTrips, totalPriceTWD, totalHotelTWD, totalActivityTWD,
        totalPaidTWD, totalPendingTWD,
        pastCostTWD, futureCostTWD, totalTripDays, sunkCostTWD,
        renderError, safeTickets, safeHotels, safeActivities
    } = useDecoratedTrips(displayTrips, tickets, rawHotels, activities);

    // 2.5 串接 TrekContext 旅程狀態（封存/結束判定 + 易讀標題關聯）
    const enrichedDecoratedTrips = useMemo(() => {
        if (!Array.isArray(decoratedTrips)) return [];
        const safeTrekTrips = Array.isArray(trekTrips) ? trekTrips : [];

        return decoratedTrips.map(trip => {
            const segs = trip.segments || [];
            const tripStartDate = segs[0]?.date;
            const tripEndDate = segs[segs.length - 1]?.arrivalDate || segs[segs.length - 1]?.date;

            const matchedTrekTrip = safeTrekTrips.find(tt => {
                if (!tt) return false;
                if (tt.id === trip.id || (tt.legacyTripKey && tt.legacyTripKey === trip.id)) return true;
                if (segs.some(s => s?.ticket?.tripId && s.ticket.tripId === tt.id)) return true;
                if (tripStartDate && tripEndDate && tt.startDate && tt.endDate) {
                    return isDateOverlap(tripStartDate, tripEndDate, tt.startDate, tt.endDate);
                }
                return false;
            });

            const isArchived = Boolean(
                trip.isArchived ||
                (matchedTrekTrip && isTripArchivedOrEnded(matchedTrekTrip))
            );
            const customLabel = (tripLabels && tripLabels[trip.id])
                || matchedTrekTrip?.title
                || trip.customLabel
                || buildReadableTripLabel(trip);

            return {
                ...trip,
                isArchived,
                customLabel,
            };
        });
    }, [decoratedTrips, trekTrips, tripLabels]);

    const enrichedRawHotels = useMemo(() => {
        if (!Array.isArray(rawHotels)) return [];
        const safeTrekTrips = Array.isArray(trekTrips) ? trekTrips : [];
        if (safeTrekTrips.length === 0) return rawHotels;

        return rawHotels.map(hotel => {
            if (!hotel) return hotel;
            // 若飯店明確歸屬於某趟 TrekTrip，直接依該趟狀態判定
            if (hotel.tripId) {
                const ownerTrip = safeTrekTrips.find(tt => tt && tt.id === hotel.tripId);
                if (ownerTrip) {
                    return { ...hotel, isArchived: isTripArchivedOrEnded(ownerTrip) };
                }
            }
            // 若依日期落在已封存/已結束旅程，且未與任何進行中/規劃中旅程重疊，視為封存住宿
            if (hotel.checkIn && hotel.checkOut) {
                const overlapsActive = safeTrekTrips.some(
                    tt => tt && !isTripArchivedOrEnded(tt) && isDateOverlap(hotel.checkIn, hotel.checkOut, tt.startDate, tt.endDate)
                );
                const overlapsArchived = safeTrekTrips.some(
                    tt => tt && isTripArchivedOrEnded(tt) && isDateOverlap(hotel.checkIn, hotel.checkOut, tt.startDate, tt.endDate)
                );
                if (overlapsArchived && !overlapsActive) {
                    return { ...hotel, isArchived: true };
                }
            }
            return hotel;
        });
    }, [rawHotels, trekTrips]);

    // 3. 建立完整時間軸資料
    const computedItinerary = useItinerary(
        enrichedDecoratedTrips,
        enrichedRawHotels,
        Array.isArray(activities) ? activities : []
    );

    // 若在唯讀分享模式且本地無資料，直接採用分享快照中的行程、飯店與活動
    const effectiveItinerary = useMemo(() => {
        if (isSharedView && sharedTripData?.itinerary?.length > 0 && computedItinerary.length === 0) {
            return sharedTripData.itinerary;
        }
        return computedItinerary;
    }, [isSharedView, sharedTripData, computedItinerary]);

    const effectiveHotels = useMemo(() => {
        if (isSharedView && sharedTripData?.hotels?.length > 0 && safeHotels.length === 0) {
            return sharedTripData.hotels;
        }
        return safeHotels;
    }, [isSharedView, sharedTripData, safeHotels]);

    const effectiveActivities = useMemo(() => {
        if (isSharedView && sharedTripData?.activities?.length > 0 && safeActivities.length === 0) {
            return sharedTripData.activities;
        }
        return safeActivities;
    }, [isSharedView, sharedTripData, safeActivities]);

    // 依 ticketScope 篩選目前作用域的票券憑證清單 (預設 By 當前行程)
    const targetTickets = useMemo(() => {
        if (ticketScope === 'all' || !activeTrip) return safeTickets;
        return (safeTickets || []).filter(t => 
            (t.tripId && t.tripId === activeTrip.id) ||
            isDateOverlap(t.outboundDate, t.returnDate, activeTrip.startDate, activeTrip.endDate)
        );
    }, [safeTickets, ticketScope, activeTrip]);

    const targetHotels = useMemo(() => {
        if (ticketScope === 'all' || !activeTrip) return effectiveHotels;
        return (effectiveHotels || []).filter(h => 
            (h.tripId && h.tripId === activeTrip.id) ||
            isDateOverlap(h.checkIn, h.checkOut, activeTrip.startDate, activeTrip.endDate)
        );
    }, [effectiveHotels, ticketScope, activeTrip]);

    const targetActivities = useMemo(() => {
        if (ticketScope === 'all' || !activeTrip) return effectiveActivities;
        return (effectiveActivities || []).filter(a => 
            (a.tripId && a.tripId === activeTrip.id) ||
            isDateOverlap(a.startDate, a.endDate, activeTrip.startDate, activeTrip.endDate)
        );
    }, [effectiveActivities, ticketScope, activeTrip]);

    // 4. 執行搜尋與狀態篩選
    const filteredTickets = useFilteredItems(targetTickets, searchTerm, filterStatus, 'tickets');
    const filteredHotels = useFilteredItems(targetHotels, searchTerm, filterStatus, 'hotels');
    const filteredActivities = useFilteredItems(targetActivities, searchTerm, filterStatus, 'activities');
    const filteredItinerary = useFilteredItems(effectiveItinerary, searchTerm, filterStatus, 'itinerary', tripLabels);

    // 5. 地圖專用過濾
    const itineraryForMap = useMemo(() => {
        if (selectedTripIdForMap) return filteredItinerary.filter(trip => trip.id === selectedTripIdForMap);
        return filteredItinerary;
    }, [filteredItinerary, selectedTripIdForMap]);

    const hotelsForMap = useMemo(() => {
        if (selectedTripIdForMap && itineraryForMap.length > 0) {
            const tripHotelIds = new Set((itineraryForMap[0].matchedHotels ?? []).map(h => h.id));
            return filteredHotels.filter(hotel => tripHotelIds.has(hotel.id));
        }
        return filteredHotels;
    }, [filteredHotels, selectedTripIdForMap, itineraryForMap]);

    const value = {
        displayTrips,
        decoratedTrips,
        trips: decoratedTrips, // 增加別名以相容 Dashboard 解構
        safeTickets,
        safeHotels: effectiveHotels,
        safeActivities: effectiveActivities,
        totalPriceTWD, totalHotelTWD, totalActivityTWD,
        totalPaidTWD, totalPendingTWD,
        pastCostTWD, futureCostTWD, totalTripDays, sunkCostTWD,
        renderError,
        filteredTickets, filteredHotels, filteredActivities, filteredItinerary,
        itineraryForMap, hotelsForMap
    };

    return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilterContext() {
    return useContext(FilterContext);
}
