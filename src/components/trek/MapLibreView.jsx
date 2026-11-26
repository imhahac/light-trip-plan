/**
 * MapLibreView.jsx
 * 現代化向量地圖視窗 (MapLibre GL JS + OpenFreeMap Liberty 向量圖資)
 * - 100% 免 Token、高流暢度 (60 FPS) 向量旋轉與俯仰
 * - 支援景點標記、編號標籤、起訖飯店標記
 * - 支援 OSRM 實際道路轉折線 (GeoJSON LineString) 繪製
 * - 內建 WebGL 上下文釋放防護 (嚴格 map.remove cleanup)
 */

import React, { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Loader2, Mountain, Layers, Route } from 'lucide-react';
import { fetchViewportPOIs } from '../../services/places/placeSearchService';
import { useI18n } from '../../i18n';

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export const MAP_STYLES = [
    {
        id: 'streets',
        label: '🏙️ 商業街圖',
        style: {
            version: 8,
            sources: {
                'esri-streets': {
                    type: 'raster',
                    tiles: [
                        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'
                    ],
                    tileSize: 256,
                    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, TomTom'
                }
            },
            layers: [
                {
                    id: 'esri-streets-layer',
                    type: 'raster',
                    source: 'esri-streets',
                    minzoom: 0,
                    maxzoom: 19
                }
            ]
        }
    },
    {
        id: 'osm',
        label: '🗺️ 開放圖資 (OSM)',
        style: {
            version: 8,
            sources: {
                'osm-raster': {
                    type: 'raster',
                    tiles: [
                        'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
                    ],
                    tileSize: 256,
                    attribution: '&copy; OpenStreetMap contributors'
                }
            },
            layers: [
                {
                    id: 'osm-raster-layer',
                    type: 'raster',
                    source: 'osm-raster',
                    minzoom: 0,
                    maxzoom: 19
                }
            ]
        }
    },
    {
        id: 'topo',
        label: '⛰️ 商務地形',
        style: {
            version: 8,
            sources: {
                'esri-topo': {
                    type: 'raster',
                    tiles: [
                        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'
                    ],
                    tileSize: 256,
                    attribution: 'Tiles &copy; Esri &mdash; USGS, Esri, TANA, DeLorme'
                }
            },
            layers: [
                {
                    id: 'esri-topo-layer',
                    type: 'raster',
                    source: 'esri-topo',
                    minzoom: 0,
                    maxzoom: 19
                }
            ]
        }
    },
    {
        id: 'satellite',
        label: '🛰️ 衛星影像',
        style: {
            version: 8,
            sources: {
                'esri-imagery': {
                    type: 'raster',
                    tiles: [
                        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                    ],
                    tileSize: 256,
                    attribution: 'Source: Esri, Maxar, Earthstar Geographics'
                }
            },
            layers: [
                {
                    id: 'esri-imagery-layer',
                    type: 'raster',
                    source: 'esri-imagery',
                    minzoom: 0,
                    maxzoom: 19
                }
            ]
        }
    }
];

export default function MapLibreView({ 
    places = [], 
    activePlaceId = null,
    onPlaceClick = null,
    onAddPoiToDay = null,
    routeGeometry = null,
    gpxTrackPoints = null,
    isFullTripMode = false,
    onToggleFullTrip = null,
    defaultCenter = [121.5654, 25.0330], // [lng, lat] 預設台北 (101)
    defaultZoom = 12
}) {
    const { t } = useI18n();
    const mapContainerRef = useRef(null);
    const mapRef = useRef(null);
    const markersRef = useRef([]);
    const poiMarkersRef = useRef([]);
    const [isMapLoaded, setIsMapLoaded] = useState(false);
    const [styleVersion, setStyleVersion] = useState(0);
    const [currentStyleId, setCurrentStyleId] = useState('streets');
    const [is3dTerrain, setIs3dTerrain] = useState(false);
    const [useCluster, setUseCluster] = useState(false);
    const [poiCategory, setPoiCategory] = useState(null); // 'sights' | 'food' | 'convenience' | null
    const [pois, setPois] = useState([]);
    const [isFetchingPoi, setIsFetchingPoi] = useState(false);

    // 1. 初始化 MapLibre GL 實例
    useEffect(() => {
        if (!mapContainerRef.current) return;

        let center = defaultCenter;
        if (places && places.length > 0 && places[0].lat && places[0].lng) {
            center = [places[0].lng, places[0].lat];
        }

        const selectedStyleObj = MAP_STYLES.find(s => s.id === currentStyleId) || MAP_STYLES[0];

        const map = new maplibregl.Map({
            container: mapContainerRef.current,
            style: selectedStyleObj.style,
            center: center,
            zoom: defaultZoom,
            pitch: 0,
            bearing: 0,
            attributionControl: true
        });

        map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

        map.on('load', () => {
            setIsMapLoaded(true);
            setStyleVersion((v) => v + 1);
            mapRef.current = map;
            map.resize();
            setTimeout(() => { if (mapRef.current) mapRef.current.resize(); }, 150);
            setTimeout(() => { if (mapRef.current) mapRef.current.resize(); }, 500);
        });

        // 綁定 ResizeObserver，當切換雙欄/全螢幕或容器大小變動時自動觸發 resize
        const resizeObserver = new ResizeObserver(() => {
            if (mapRef.current) {
                mapRef.current.resize();
            }
        });
        resizeObserver.observe(mapContainerRef.current);

        // 嚴格銷毀 WebGL Context，防止記憶體洩漏與 Context Loss
        return () => {
            resizeObserver.disconnect();
            markersRef.current.forEach(m => m.remove());
            markersRef.current = [];
            poiMarkersRef.current.forEach(m => m.remove());
            poiMarkersRef.current = [];
            map.remove();
            mapRef.current = null;
            setIsMapLoaded(false);
        };
    }, []);

    // 當使用者手動切換圖資樣式：style.load 後遞增 styleVersion 強制重建所有動態圖層與 3D 地形
    const handleSwitchStyle = (styleId) => {
        const map = mapRef.current;
        if (styleId === currentStyleId || !map) return;
        const target = MAP_STYLES.find(s => s.id === styleId);
        if (target) {
            setCurrentStyleId(styleId);
            map.setStyle(target.style);
            map.once('style.load', () => {
                map.resize();
                setStyleVersion((v) => v + 1);
            });
        }
    };

    // 1.5 3D 地形 (AWS Terrarium DEM，免 API Key)
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !isMapLoaded) return;

        const demSourceId = 'terrarium-dem';
        try {
            if (is3dTerrain) {
                if (!map.getSource(demSourceId)) {
                    map.addSource(demSourceId, {
                        type: 'raster-dem',
                        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
                        encoding: 'terrarium',
                        tileSize: 256,
                        maxzoom: 14,
                    });
                }
                map.setTerrain({ source: demSourceId, exaggeration: 1.35 });
                map.easeTo({ pitch: 52, duration: 500 });
            } else {
                map.setTerrain(null);
                if (map.getSource(demSourceId)) {
                    map.removeSource(demSourceId);
                }
                if (map.getPitch() > 0) {
                    map.easeTo({ pitch: 0, duration: 400 });
                }
            }
        } catch {
            // 某些無 WebGL 擴充環境忽略地形錯誤
        }
    }, [is3dTerrain, isMapLoaded, styleVersion]);

    // 2. 繪製或更新景點 Marker (支援聚合模式 Cluster 與單點編號模式)
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !isMapLoaded) return;

        // 清除舊 Markers 與舊 Cluster 圖層
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];
        ['places-clusters', 'places-cluster-count', 'places-unclustered'].forEach((id) => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource('places-cluster-src')) map.removeSource('places-cluster-src');

        if (!places || places.length === 0) return;

        map.resize();

        const bounds = new maplibregl.LngLatBounds();
        const validPlaces = [];
        places.forEach((place, index) => {
            const lat = Number(place.lat);
            const lng = Number(place.lng);
            if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return;
            bounds.extend([lng, lat]);
            validPlaces.push({ ...place, lat, lng, _idx: index + 1 });
        });

        if (useCluster && validPlaces.length >= 2) {
            map.addSource('places-cluster-src', {
                type: 'geojson',
                data: {
                    type: 'FeatureCollection',
                    features: validPlaces.map((p) => ({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
                        properties: { id: p.id, name: p.name || '', idx: p._idx },
                    })),
                },
                cluster: true,
                clusterMaxZoom: 14,
                clusterRadius: 48,
            });
            map.addLayer({
                id: 'places-clusters',
                type: 'circle',
                source: 'places-cluster-src',
                filter: ['has', 'point_count'],
                paint: {
                    'circle-color': '#4f46e5',
                    'circle-radius': ['step', ['get', 'point_count'], 18, 10, 24, 30, 30],
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff',
                },
            });
            map.addLayer({
                id: 'places-cluster-count',
                type: 'symbol',
                source: 'places-cluster-src',
                filter: ['has', 'point_count'],
                layout: { 'text-field': '{point_count_abbreviated}', 'text-size': 12 },
                paint: { 'text-color': '#ffffff' },
            });
            map.addLayer({
                id: 'places-unclustered',
                type: 'circle',
                source: 'places-cluster-src',
                filter: ['!', ['has', 'point_count']],
                paint: {
                    'circle-color': '#6366f1',
                    'circle-radius': 8,
                    'circle-stroke-width': 2,
                    'circle-stroke-color': '#ffffff',
                },
            });
        } else {
            validPlaces.forEach((place) => {
                const el = document.createElement('div');
                el.className = 'group cursor-pointer select-none';
                el.style.width = '32px';
                el.style.height = '32px';
                el.style.display = 'flex';
                el.style.alignItems = 'center';
                el.style.justifyContent = 'center';

                const isActive = place.id === activePlaceId;
                const isHotel = place.isAnchorStart || place.isAnchorEnd || place.category === 'hotel';

                el.innerHTML = `
                    <div class="relative flex items-center justify-center w-7 h-7 rounded-full shadow-lg font-black text-xs transition-transform duration-150 transform group-hover:scale-125 border-2 border-white ${
                        isActive 
                            ? 'bg-rose-500 text-white ring-4 ring-rose-300' 
                            : isHotel 
                                ? 'bg-amber-500 text-white' 
                                : 'bg-indigo-600 text-white'
                    }">
                        <span>${isHotel ? '🏨' : place._idx}</span>
                        <div class="absolute left-1/2 -translate-x-1/2 bottom-8 hidden group-hover:block bg-slate-900/90 text-white text-[11px] font-bold px-2 py-1 rounded shadow-md whitespace-nowrap z-50 pointer-events-none">
                            ${escapeHtml(place.name)}
                        </div>
                    </div>
                `;

                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (onPlaceClick) onPlaceClick(place);
                });

                const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
                    .setLngLat([place.lng, place.lat])
                    .addTo(map);

                markersRef.current.push(marker);
            });
        }

        // 自動縮放與視野貼齊
        if (validPlaces.length > 1) {
            map.fitBounds(bounds, { padding: 60, maxZoom: 15, duration: 600 });
        } else if (validPlaces.length === 1) {
            map.flyTo({ center: [validPlaces[0].lng, validPlaces[0].lat], zoom: 14, duration: 600 });
        }
    }, [places, activePlaceId, isMapLoaded, styleVersion, useCluster, onPlaceClick]);

    // 2.5 繪製 Overpass 探索出的周邊 POI Marker（點擊可直接加入當日行程）
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !isMapLoaded) return;

        poiMarkersRef.current.forEach((m) => m.remove());
        poiMarkersRef.current = [];

        pois.forEach((poi) => {
            if (!Number.isFinite(Number(poi.lat)) || !Number.isFinite(Number(poi.lng))) return;
            const el = document.createElement('div');
            el.className = 'cursor-pointer select-none';
            const badgeColor = poi.category === 'food' ? 'bg-amber-500' : poi.category === 'convenience' ? 'bg-emerald-500' : 'bg-rose-500';
            const iconText = poi.category === 'food' ? '🍜' : poi.category === 'convenience' ? '🏪' : '🏛️';
            el.innerHTML = `<div class="w-6 h-6 rounded-full ${badgeColor} text-white text-[11px] flex items-center justify-center shadow-md border-2 border-white hover:scale-125 transition-transform">${iconText}</div>`;

            const popupEl = document.createElement('div');
            popupEl.className = 'p-1 text-xs space-y-1.5 min-w-[150px]';
            const titleDiv = document.createElement('div');
            titleDiv.className = 'font-bold text-slate-900';
            titleDiv.textContent = poi.name;
            popupEl.appendChild(titleDiv);

            if (poi.openingHours) {
                const hrDiv = document.createElement('div');
                hrDiv.className = 'text-[10px] text-slate-500';
                hrDiv.textContent = `🕒 ${poi.openingHours}`;
                popupEl.appendChild(hrDiv);
            }

            if (onAddPoiToDay) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'w-full px-2 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-[11px] font-bold';
                btn.textContent = `＋ ${t('map.addToDay', '加入行程')}`;
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    onAddPoiToDay(poi);
                });
                popupEl.appendChild(btn);
            }

            const popup = new maplibregl.Popup({ offset: 14, closeButton: true }).setDOMContent(popupEl);
            const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
                .setLngLat([Number(poi.lng), Number(poi.lat)])
                .setPopup(popup)
                .addTo(map);
            poiMarkersRef.current.push(marker);
        });
    }, [pois, isMapLoaded, styleVersion, onAddPoiToDay, t]);

    // 3. 繪製 OSRM 道路轉折路線 (GeoJSON LineString) — styleVersion 變動時自動重建
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !isMapLoaded) return;

        const sourceId = 'route-source';
        const layerId = 'route-layer';

        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);

        if (routeGeometry && routeGeometry.coordinates && routeGeometry.coordinates.length > 1) {
            map.addSource(sourceId, {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    geometry: routeGeometry
                }
            });

            map.addLayer({
                id: layerId,
                type: 'line',
                source: sourceId,
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#4f46e5',
                    'line-width': 4,
                    'line-opacity': 0.85
                }
            });
        }
    }, [routeGeometry, isMapLoaded, styleVersion]);

    // 3.5 繪製 GPX 戶外軌跡線 (Light Tours)
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !isMapLoaded) return;

        const srcId = 'gpx-track-source';
        const layerId = 'gpx-track-layer';
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(srcId)) map.removeSource(srcId);

        if (Array.isArray(gpxTrackPoints) && gpxTrackPoints.length > 1) {
            const coords = gpxTrackPoints.map((p) => [Number(p.lng), Number(p.lat)]);
            map.addSource(srcId, {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: coords },
                },
            });
            map.addLayer({
                id: layerId,
                type: 'line',
                source: srcId,
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#10b981', 'line-width': 4, 'line-opacity': 0.9 },
            });
            const bounds = new maplibregl.LngLatBounds();
            coords.forEach((c) => bounds.extend(c));
            map.fitBounds(bounds, { padding: 50, maxZoom: 15, duration: 500 });
        }
    }, [gpxTrackPoints, isMapLoaded, styleVersion]);

    // 4. Overpass POI 景點探索引擎
    const handleTogglePOI = async (cat) => {
        const map = mapRef.current;
        if (!map || !isMapLoaded) return;

        if (poiCategory === cat) {
            setPoiCategory(null);
            setPois([]);
            return;
        }

        setPoiCategory(cat);
        setIsFetchingPoi(true);

        const bounds = map.getBounds();
        const bbox = {
            south: bounds.getSouth(),
            west: bounds.getWest(),
            north: bounds.getNorth(),
            east: bounds.getEast()
        };

        const results = await fetchViewportPOIs(bbox, cat, 25);
        setPois(results);
        setIsFetchingPoi(false);
    };

    return (
        <div className="relative w-full h-full min-h-[400px]">
            {/* MapLibre DOM 容器 */}
            <div ref={mapContainerRef} className="w-full h-full absolute inset-0" />

            {/* 視角與 POI 探索浮動工具列 */}
            <div className="absolute top-3 left-3 right-12 z-10 flex flex-wrap items-center gap-1.5">
                <button
                    onClick={() => handleTogglePOI('sights')}
                    className={`px-2 py-1.5 rounded-lg text-[11px] font-bold shadow-md backdrop-blur-md transition flex items-center gap-1 ${
                        poiCategory === 'sights'
                            ? 'bg-rose-600 text-white'
                            : 'bg-white/90 text-slate-700 hover:bg-white border border-gray-200'
                    }`}
                >
                    <span>🏛️ 景點</span>
                    {poiCategory === 'sights' && isFetchingPoi && <Loader2 className="w-3 h-3 animate-spin" />}
                </button>
                <button
                    onClick={() => handleTogglePOI('food')}
                    className={`px-2 py-1.5 rounded-lg text-[11px] font-bold shadow-md backdrop-blur-md transition flex items-center gap-1 ${
                        poiCategory === 'food'
                            ? 'bg-amber-600 text-white'
                            : 'bg-white/90 text-slate-700 hover:bg-white border border-gray-200'
                    }`}
                >
                    <span>🍜 美食</span>
                    {poiCategory === 'food' && isFetchingPoi && <Loader2 className="w-3 h-3 animate-spin" />}
                </button>
                <button
                    onClick={() => handleTogglePOI('convenience')}
                    className={`px-2 py-1.5 rounded-lg text-[11px] font-bold shadow-md backdrop-blur-md transition flex items-center gap-1 ${
                        poiCategory === 'convenience'
                            ? 'bg-emerald-600 text-white'
                            : 'bg-white/90 text-slate-700 hover:bg-white border border-gray-200'
                    }`}
                >
                    <span>🏪 超商</span>
                    {poiCategory === 'convenience' && isFetchingPoi && <Loader2 className="w-3 h-3 animate-spin" />}
                </button>

                {/* 3D 地形、聚合與全行程總覽開關 */}
                <button
                    type="button"
                    onClick={() => setIs3dTerrain((v) => !v)}
                    className={`px-2 py-1.5 rounded-lg text-[11px] font-bold shadow-md backdrop-blur-md transition flex items-center gap-1 ${
                        is3dTerrain
                            ? 'bg-emerald-700 text-white'
                            : 'bg-white/90 text-slate-700 hover:bg-white border border-gray-200'
                    }`}
                >
                    <Mountain className="w-3.5 h-3.5" />
                    <span>{t('map.terrain3d', '3D 地形')}</span>
                </button>

                <button
                    type="button"
                    onClick={() => setUseCluster((v) => !v)}
                    className={`px-2 py-1.5 rounded-lg text-[11px] font-bold shadow-md backdrop-blur-md transition flex items-center gap-1 ${
                        useCluster
                            ? 'bg-indigo-600 text-white'
                            : 'bg-white/90 text-slate-700 hover:bg-white border border-gray-200'
                    }`}
                >
                    <Layers className="w-3.5 h-3.5" />
                    <span>{t('map.cluster', '聚合標記')}</span>
                </button>

                {onToggleFullTrip && (
                    <button
                        type="button"
                        onClick={onToggleFullTrip}
                        className={`px-2 py-1.5 rounded-lg text-[11px] font-bold shadow-md backdrop-blur-md transition flex items-center gap-1 ${
                            isFullTripMode
                                ? 'bg-slate-900 text-white'
                                : 'bg-white/90 text-slate-700 hover:bg-white border border-gray-200'
                        }`}
                    >
                        <Route className="w-3.5 h-3.5" />
                        <span>{t('map.fullTrip', '全行程總覽')}</span>
                    </button>
                )}

                {/* 圖資樣式切換器 */}
                <div className="flex items-center bg-white/95 rounded-lg border border-gray-200 shadow-md p-0.5 backdrop-blur-md">
                    {MAP_STYLES.map(s => (
                        <button
                            key={s.id}
                            onClick={() => handleSwitchStyle(s.id)}
                            className={`px-2 py-1 rounded-md text-[11px] font-bold transition ${
                                currentStyleId === s.id
                                    ? 'bg-slate-900 text-white shadow-xs'
                                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                            }`}
                        >
                            {s.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* 尚未選定景點之提示 */}
            {places.length === 0 && (
                <div className="absolute top-16 left-3 z-10 bg-slate-900/80 text-slate-200 text-[11px] font-medium px-3 py-1.5 rounded-lg shadow-md backdrop-blur-sm pointer-events-none flex items-center gap-1.5">
                    <span>💡 目前顯示預設視野，可於左側日程新增景點，或探索周邊點位</span>
                </div>
            )}

            {/* POI 結果小計提示 */}
            {pois.length > 0 && (
                <div className="absolute bottom-3 left-3 z-10 bg-slate-900/90 text-white text-[11px] font-semibold px-3 py-1.5 rounded-lg shadow-lg backdrop-blur-md flex items-center gap-2">
                    <span>已探索到 {pois.length} 個周邊點位（點擊圖標可加入當日行程）</span>
                    <button onClick={() => { setPois([]); setPoiCategory(null); }} className="text-slate-400 hover:text-white">&times;</button>
                </div>
            )}
        </div>
    );
}
