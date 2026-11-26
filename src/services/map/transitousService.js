/**
 * transitousService.js
 * Door-to-door public transport itineraries via free Transitous (MOTIS v1) API,
 * with automatic fallback to Google Maps transit directions when coverage is unavailable.
 */

import { logger } from '../../utils/logger';
import { isEffectivelyOffline } from '../sync/offlineModeService';

const TRANSITOUS_API = 'https://api.transitous.org/api/v1/plan';
const TIMEOUT_MS = 8000;

export function getGoogleMapsTransitUrl(from, to) {
    if (!from || !to) return null;
    return `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=transit`;
}

/**
 * Query Transitous public transit routing between two coordinates.
 * @param {{ lat: number, lng: number, name?: string }} from
 * @param {{ lat: number, lng: number, name?: string }} to
 * @param {string} [departureIso] ISO-8601 datetime string (defaults to now)
 */
export async function queryPublicTransitRoute(from, to, departureIso = null) {
    const fallbackUrl = getGoogleMapsTransitUrl(from, to);
    if (!from || !to || !Number.isFinite(Number(from.lat)) || !Number.isFinite(Number(to.lat))) {
        return { ok: false, itineraries: [], fallbackUrl, error: '無效的起訖座標' };
    }
    if (isEffectivelyOffline()) {
        return { ok: false, itineraries: [], fallbackUrl, error: '目前為離線模式，無法查詢即時大眾運輸' };
    }

    const params = new URLSearchParams({
        fromPlace: `${Number(from.lat)},${Number(from.lng)}`,
        toPlace: `${Number(to.lat)},${Number(to.lng)}`,
        numItineraries: '3',
    });
    if (departureIso) {
        params.set('time', departureIso);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(`${TRANSITOUS_API}?${params.toString()}`, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
            return { ok: false, itineraries: [], fallbackUrl, error: `Transitous HTTP ${res.status}` };
        }
        const data = await res.json();
        const rawList = Array.isArray(data.itineraries) ? data.itineraries : [];

        const itineraries = rawList.slice(0, 3).map((it) => ({
            durationMin: Math.max(1, Math.round((it.duration || 0) / 60)),
            transfers: it.transfers ?? 0,
            startTime: it.startTime || null,
            endTime: it.endTime || null,
            legs: (it.legs || []).map((leg) => ({
                mode: leg.mode || 'WALK',
                routeShortName: leg.routeShortName || leg.headsign || '',
                fromName: leg.from?.name || '',
                toName: leg.to?.name || '',
                durationMin: Math.max(1, Math.round((leg.duration || 0) / 60)),
            })),
        }));

        return {
            ok: itineraries.length > 0,
            itineraries,
            fallbackUrl,
            source: 'transitous',
        };
    } catch (err) {
        logger.warn('Transitous transit query failed, using Google Maps fallback:', err);
        return {
            ok: false,
            itineraries: [],
            fallbackUrl,
            error: err?.name === 'AbortError' ? '大眾運輸查詢逾時' : err?.message || '查詢失敗',
        };
    } finally {
        clearTimeout(timer);
    }
}
