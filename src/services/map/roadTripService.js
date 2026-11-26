/**
 * roadTripService.js
 * Opt-in Road Trip schedule calculator:
 * Computes arrival (ETA), departure (ETD), driving leg minutes, and warns when stops exceed the daily driving window.
 */

function haversineDistance(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Parse "HH:MM" into minutes from midnight.
 */
export function parseTimeToMinutes(hhmm, fallbackMinutes = 540) {
    if (!hhmm || typeof hhmm !== 'string') return fallbackMinutes;
    const match = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return fallbackMinutes;
    const h = Math.min(23, Math.max(0, parseInt(match[1], 10)));
    const m = Math.min(59, Math.max(0, parseInt(match[2], 10)));
    return h * 60 + m;
}

/**
 * Format minutes from midnight into "HH:MM" (or "+1d HH:MM" if past midnight).
 */
export function formatMinutesToTime(totalMinutes) {
    const dayOverflow = Math.floor(totalMinutes / 1440);
    const mod = ((totalMinutes % 1440) + 1440) % 1440;
    const h = String(Math.floor(mod / 60)).padStart(2, '0');
    const m = String(mod % 60).padStart(2, '0');
    return dayOverflow > 0 ? `+${dayOverflow}d ${h}:${m}` : `${h}:${m}`;
}

/**
 * Compute road-trip timeline for an ordered list of stops.
 * @param {Array<{ id: string, name: string, lat?: number, lng?: number, dwellMin?: number }>} places
 * @param {{
 *   dayStartTime?: string,
 *   dayEndTime?: string,
 *   defaultDwellMin?: number,
 *   avgSpeedKmh?: number,
 *   legDurationsMin?: number[],
 *   evRangeKm?: number | null
 * }} [options]
 */
export function computeRoadTripSchedule(places = [], options = {}) {
    const startMin = parseTimeToMinutes(options.dayStartTime || '09:00', 540);
    const endMin = parseTimeToMinutes(options.dayEndTime || '18:00', 1080);
    const defaultDwell = Number.isFinite(options.defaultDwellMin) ? options.defaultDwellMin : 45;
    const avgSpeedKmh = options.avgSpeedKmh || 55;
    const legDurations = Array.isArray(options.legDurationsMin) ? options.legDurationsMin : null;
    const evRangeKm = Number.isFinite(options.evRangeKm) && options.evRangeKm > 0 ? options.evRangeKm : null;

    let currentClock = startMin;
    let totalDriveMin = 0;
    let totalDistanceKm = 0;
    let cumulativeEvKm = 0;
    const stops = [];

    for (let i = 0; i < places.length; i++) {
        const stop = places[i];
        let legDistanceKm = 0;
        let legDriveMin = 0;

        if (i > 0) {
            const prev = places[i - 1];
            if (
                Number.isFinite(Number(prev?.lat)) &&
                Number.isFinite(Number(prev?.lng)) &&
                Number.isFinite(Number(stop?.lat)) &&
                Number.isFinite(Number(stop?.lng))
            ) {
                // Road detour factor ~1.25x over straight-line Haversine when OSRM leg duration isn't provided
                legDistanceKm = Number((haversineDistance(Number(prev.lat), Number(prev.lng), Number(stop.lat), Number(stop.lng)) * 1.25).toFixed(1));
            }
            if (legDurations && Number.isFinite(legDurations[i - 1])) {
                legDriveMin = Math.max(1, Math.round(legDurations[i - 1]));
            } else {
                legDriveMin = legDistanceKm > 0 ? Math.max(5, Math.round((legDistanceKm / avgSpeedKmh) * 60)) : 15;
            }
            currentClock += legDriveMin;
            totalDriveMin += legDriveMin;
            totalDistanceKm += legDistanceKm;
            cumulativeEvKm += legDistanceKm;
        }

        const arrivalMin = currentClock;
        const dwellMin = i === 0 || i === places.length - 1
            ? (Number.isFinite(stop.dwellMin) ? stop.dwellMin : 0)
            : (Number.isFinite(stop.dwellMin) ? stop.dwellMin : defaultDwell);
        const departureMin = arrivalMin + dwellMin;
        currentClock = departureMin;

        const needsEvCharge = evRangeKm !== null && cumulativeEvKm >= evRangeKm * 0.8;
        if (needsEvCharge) {
            cumulativeEvKm = 0; // Reset after recommended charging stop
        }

        stops.push({
            id: stop.id,
            name: stop.name,
            legDistanceKm,
            legDriveMin,
            arrivalTime: formatMinutesToTime(arrivalMin),
            departureTime: formatMinutesToTime(departureMin),
            dwellMin,
            exceedsWindow: arrivalMin > endMin || departureMin > endMin,
            needsEvCharge,
        });
    }

    return {
        stops,
        totalDistanceKm: Number(totalDistanceKm.toFixed(1)),
        totalDriveMin,
        windowStart: formatMinutesToTime(startMin),
        windowEnd: formatMinutesToTime(endMin),
        hasOverrun: stops.some((s) => s.exceedsWindow),
    };
}
