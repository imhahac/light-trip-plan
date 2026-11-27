/**
 * flightTimezoneService.js
 * Multi-leg flight timezone & layover calculator.
 * Reuses dynamic-imported airportService (4,045+ airports with IANA `tz`) so the 1MB airports.json
 * NEVER bloats the initial JS bundle.
 */

import { getAirport } from '../airportService';

/**
 * Format a short timezone label (e.g. "UTC+9" or "Asia/Tokyo") using native Intl.DateTimeFormat.
 * @param {string} ianaTz
 * @param {Date} [refDate]
 */
export function formatTimezoneOffsetLabel(ianaTz, refDate = new Date()) {
    if (!ianaTz) return '';
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: ianaTz,
            timeZoneName: 'shortOffset',
        }).formatToParts(refDate);
        const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value || '';
        return tzPart ? `${ianaTz} (${tzPart})` : ianaTz;
    } catch {
        return ianaTz;
    }
}

/**
 * Compute layover minutes between leg[i].arrivalTime and leg[i+1].departureTime (ISO strings).
 */
export function calculateLayoverMinutes(arrivalIso, nextDepartureIso) {
    if (!arrivalIso || !nextDepartureIso) return null;
    const t1 = Date.parse(arrivalIso);
    const t2 = Date.parse(nextDepartureIso);
    if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 < t1) return null;
    return Math.round((t2 - t1) / 60000);
}

/**
 * Format minutes into human-readable duration (e.g. "2h 35m").
 */
export function formatDurationMinutes(mins) {
    if (!Number.isFinite(mins) || mins < 0) return '--';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m}m`;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Enrich an array of flight legs with airport names, IANA timezones, and layover durations.
 * @param {Array<{ from: string, to: string, departureTime?: string, arrivalTime?: string, flightNumber?: string }>} legs
 */
export async function enrichFlightLegsWithTimezones(legs = []) {
    if (!Array.isArray(legs) || legs.length === 0) return [];

    const enriched = await Promise.all(
        legs.map(async (leg) => {
            const [depAp, arrAp] = await Promise.all([
                getAirport(leg.from),
                getAirport(leg.to),
            ]);
            const depDate = leg.departureTime ? new Date(leg.departureTime) : new Date();
            const arrDate = leg.arrivalTime ? new Date(leg.arrivalTime) : depDate;
            return {
                ...leg,
                fromTz: depAp?.tz || null,
                fromTzLabel: depAp?.tz ? formatTimezoneOffsetLabel(depAp.tz, depDate) : '',
                fromName: depAp?.zh || depAp?.city || depAp?.name || leg.from || '',
                toTz: arrAp?.tz || null,
                toTzLabel: arrAp?.tz ? formatTimezoneOffsetLabel(arrAp.tz, arrDate) : '',
                toName: arrAp?.zh || arrAp?.city || arrAp?.name || leg.to || '',
            };
        })
    );

    return enriched.map((leg, idx) => {
        if (idx === 0) return { ...leg, layoverMinutes: null, layoverLabel: '' };
        const prev = enriched[idx - 1];
        const layoverMinutes = calculateLayoverMinutes(prev.arrivalTime, leg.departureTime);
        return {
            ...leg,
            layoverMinutes,
            layoverLabel: layoverMinutes != null ? formatDurationMinutes(layoverMinutes) : '',
        };
    });
}
