/**
 * routeService.js
 * 路線導航與轉向幾何服務：
 * 1. OSRM 駕車、步行、自行車路線計算 (免 Key，回傳 GeoJSON LineString 與耗時)
 * 2. Transitous 門到門大眾運輸行程
 * 3. 外部地圖 (Google Maps / CoMaps / Apple Maps) 一鍵導航深度連結
 */

import { logger } from '../../utils/logger';
import { isEffectivelyOffline } from '../sync/offlineModeService';

const OSRM_TIMEOUT_MS = 8000;
const FALLBACK_SPEED_KMH = {
    walking: 4.5,
    cycling: 15,
    driving: 35,
};

function haversineKm(a, b) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(Number(b.lat) - Number(a.lat));
    const dLng = toRad(Number(b.lng) - Number(a.lng));
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(Number(a.lat))) * Math.cos(toRad(Number(b.lat))) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function buildFallbackRoute(coordinates, profile = 'driving') {
    let dist = 0;
    for (let i = 1; i < coordinates.length; i++) {
        dist += haversineKm(coordinates[i - 1], coordinates[i]) * 1.22;
    }
    const speed = FALLBACK_SPEED_KMH[profile] || 35;
    return {
        distanceKm: Math.round(dist * 10) / 10,
        durationMinutes: Math.max(1, Math.round((dist / speed) * 60)),
        geometry: {
            type: 'LineString',
            coordinates: coordinates.map((c) => [Number(c.lng), Number(c.lat)]),
        },
        estimated: true,
        profile,
    };
}

/**
 * 依交通模式選擇對應的免費 OSRM 路網節點：
 * - walking -> routing.openstreetmap.de/routed-foot
 * - cycling -> routing.openstreetmap.de/routed-bike
 * - driving -> router.project-osrm.org (car)
 */
export function buildOsrmEndpointUrl(coordString, profile = 'driving') {
    if (profile === 'walking') {
        return `https://routing.openstreetmap.de/routed-foot/route/v1/driving/${coordString}?overview=full&geometries=geojson`;
    }
    if (profile === 'cycling') {
        return `https://routing.openstreetmap.de/routed-bike/route/v1/driving/${coordString}?overview=full&geometries=geojson`;
    }
    return `https://router.project-osrm.org/route/v1/driving/${coordString}?overview=full&geometries=geojson`;
}

/**
 * 透過 OSRM 計算實際道路行車/步行/自行車線段（含 8s Timeout、離線短路與自動均速降級）
 * @param {Array<{lat: number, lng: number}>} coordinates - 順序經緯度
 * @param {'driving' | 'walking' | 'cycling'} profile
 * @returns {Promise<{distanceKm: number, durationMinutes: number, geometry: Object, estimated?: boolean, profile: string}|null>}
 */
export async function getOSRMRoute(coordinates, profile = 'driving') {
    if (!coordinates || coordinates.length < 2) return null;

    if (isEffectivelyOffline()) {
        return buildFallbackRoute(coordinates, profile);
    }

    // OSRM 格式為: lng,lat;lng,lat;...
    const coordString = coordinates
        .map(c => `${Number(c.lng).toFixed(5)},${Number(c.lat).toFixed(5)}`)
        .join(';');

    const url = buildOsrmEndpointUrl(coordString, profile);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);

    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            logger.warn(`OSRM Route (${profile}) failed with status: ${res.status}, using fallback`);
            return buildFallbackRoute(coordinates, profile);
        }
        const data = await res.json();
        if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
            return buildFallbackRoute(coordinates, profile);
        }

        const route = data.routes[0];
        return {
            distanceKm: Math.round((route.distance / 1000) * 10) / 10,
            durationMinutes: Math.max(1, Math.round(route.duration / 60)),
            geometry: route.geometry,
            estimated: false,
            profile,
        };
    } catch (err) {
        logger.warn(`OSRM route (${profile}) error, using Haversine fallback:`, err);
        return buildFallbackRoute(coordinates, profile);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 逐段依各景點的 travelModeToNext ('driving' | 'walking' | 'cycling') 計算多段路線並合併 GeoJSON
 * @param {Array<{ id: string, lat: number, lng: number, travelModeToNext?: string }>} places
 */
export async function getMultiLegRoute(places = []) {
    const valid = places.filter(
        (p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)) && !(Number(p.lat) === 0 && Number(p.lng) === 0)
    );
    if (valid.length < 2) return null;

    const legTasks = [];
    for (let i = 0; i < valid.length - 1; i++) {
        const from = valid[i];
        const to = valid[i + 1];
        const mode = from.travelModeToNext || 'driving';
        legTasks.push(
            getOSRMRoute([from, to], mode).then((res) => ({
                fromId: from.id,
                toId: to.id,
                mode,
                distanceKm: res?.distanceKm ?? 0,
                durationMinutes: res?.durationMinutes ?? 0,
                estimated: Boolean(res?.estimated),
                coordinates: res?.geometry?.coordinates || [[Number(from.lng), Number(from.lat)], [Number(to.lng), Number(to.lat)]],
            }))
        );
    }

    const legs = await Promise.all(legTasks);
    const mergedCoords = [];
    let totalDistanceKm = 0;
    let totalDurationMinutes = 0;

    legs.forEach((leg, idx) => {
        totalDistanceKm += leg.distanceKm;
        totalDurationMinutes += leg.durationMinutes;
        const pts = idx > 0 ? leg.coordinates.slice(1) : leg.coordinates;
        mergedCoords.push(...pts);
    });

    return {
        distanceKm: Math.round(totalDistanceKm * 10) / 10,
        durationMinutes: totalDurationMinutes,
        legs,
        geometry: {
            type: 'LineString',
            coordinates: mergedCoords,
        },
    };
}

/**
 * 產生 Google Maps 外部路徑規劃 URL (支援多中途點 waypoints)
 */
export function getGoogleMapsRouteUrl(places) {
    if (!places || places.length === 0) return 'https://www.google.com/maps';
    if (places.length === 1) {
        return `https://www.google.com/maps/search/?api=1&query=${places[0].lat},${places[0].lng}`;
    }

    const origin = `${places[0].lat},${places[0].lng}`;
    const destination = `${places[places.length - 1].lat},${places[places.length - 1].lng}`;
    
    // 中途停靠點 (最多 9 個 waypoints)
    const waypoints = places
        .slice(1, -1)
        .slice(0, 9)
        .map(p => `${p.lat},${p.lng}`)
        .join('|');

    let url = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
    if (waypoints) {
        url += `&waypoints=${encodeURIComponent(waypoints)}`;
    }
    return url;
}

/**
 * 產生 CoMaps / Organic Maps 外部連結
 */
export function getCoMapsRouteUrl(places) {
    if (!places || places.length === 0) return 'https://comaps.app';
    const first = places[0];
    return `https://comaps.app/#map=14/${first.lat}/${first.lng}`;
}

/**
 * Transitous 大眾運輸行程查詢 (開放公車/鐵路/捷運)
 */
export async function getTransitousItinerary(fromCoord, toCoord, departureTime = null) {
    if (!fromCoord || !toCoord) return null;
    try {
        const timeParam = departureTime ? `&time=${encodeURIComponent(departureTime)}` : '';
        const url = `https://api.transitous.org/routing?from=${fromCoord.lat},${fromCoord.lng}&to=${toCoord.lat},${toCoord.lng}${timeParam}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        logger.warn('Transitous API unavailable, falling back:', e);
        return null;
    }
}
