import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { validateConfig } from '../constants/config';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { useLocalStorage } from '../hooks/useLocalStorage';

const UIContext = createContext();

const VALID_TABS = new Set([
    'planner',
    'timeline',
    'reservations',
    'calendar',
    'map',
    'costs',
    'analytics',
    'packing',
    'list',
    'hotels',
    'activities',
]);

const WORKSPACE_BY_TAB = {
    planner: 'planning',
    timeline: 'planning',
    reservations: 'planning',
    calendar: 'planning',
    map: 'planning',
    costs: 'finance',
    analytics: 'finance',
    packing: 'prep',
    list: 'tickets',
    hotels: 'tickets',
    activities: 'tickets',
};

export function UIProvider({ children }) {
    const [storedActiveTab, setStoredActiveTab] = useLocalStorage(STORAGE_KEYS.UI_ACTIVE_TAB, 'timeline');
    const [workspaceTabs, setWorkspaceTabs] = useLocalStorage(STORAGE_KEYS.UI_WORKSPACE_TABS, {});
    const [searchTerm, setSearchTerm] = useState('');
    const [filterStatus, setFilterStatus] = useLocalStorage(STORAGE_KEYS.UI_FILTER_STATUS, 'all');
    const [ticketScope, setTicketScope] = useLocalStorage(STORAGE_KEYS.UI_TICKET_SCOPE, 'trip'); // 'trip' | 'all'
    const [configWarnings, setConfigWarnings] = useState([]);
    
    // Map selection states
    const [selectedHotelIdForMap, setSelectedHotelIdForMap] = useState(null);
    const [selectedTripIdForMap, setSelectedTripIdForMap] = useState(null);

    const fileInputRef = useRef(null);

    const activeTab = VALID_TABS.has(storedActiveTab) ? storedActiveTab : 'timeline';

    const setActiveTab = useCallback((nextTabOrUpdater) => {
        setStoredActiveTab((prev) => {
            const current = VALID_TABS.has(prev) ? prev : 'timeline';
            const resolved = typeof nextTabOrUpdater === 'function' ? nextTabOrUpdater(current) : nextTabOrUpdater;
            const validNext = VALID_TABS.has(resolved) ? resolved : 'timeline';
            const wsId = WORKSPACE_BY_TAB[validNext];
            if (wsId) {
                setWorkspaceTabs((prevWs) => ({
                    ...(prevWs || {}),
                    [wsId]: validNext,
                }));
            }
            return validNext;
        });
    }, [setStoredActiveTab, setWorkspaceTabs]);

    React.useEffect(() => {
        const warnings = validateConfig();
        setConfigWarnings(warnings);
    }, []);

    const handleSelectTripForMap = (tripId) => {
        setSelectedHotelIdForMap(null);
        setSelectedTripIdForMap(tripId);
        setActiveTab('map');
    };
    
    const handleSelectHotelForMap = (hotelId, tripId) => {
        setSelectedHotelIdForMap(hotelId);
        handleSelectTripForMap(tripId);
    };

    const handleClearSelectedTripForMap = () => {
        setSelectedTripIdForMap(null);
    };

    const value = {
        activeTab, setActiveTab,
        workspaceTabs, setWorkspaceTabs,
        searchTerm, setSearchTerm,
        filterStatus, setFilterStatus,
        ticketScope, setTicketScope,
        configWarnings, setConfigWarnings,
        selectedHotelIdForMap, setSelectedHotelIdForMap,
        selectedTripIdForMap, setSelectedTripIdForMap,
        handleSelectTripForMap, handleSelectHotelForMap, handleClearSelectedTripForMap,
        fileInputRef
    };

    return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

export function useUIContext() {
    return useContext(UIContext);
}
