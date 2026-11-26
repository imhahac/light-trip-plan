/**
 * navigationLinks.js
 * Multi-navigation-app deep links for single places (7 apps) and full-day routes (Google Maps & CoMaps).
 */

function isValidCoord(lat, lng) {
    return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && !(Number(lat) === 0 && Number(lng) === 0);
}

/**
 * Generate deep links for a single place across 7 navigation apps.
 * @param {{ name?: string, lat: number, lng: number }} place
 * @returns {Array<{ id: string, label: string, url: string }>}
 */
export function getPlaceNavigationLinks(place) {
    if (!place || !isValidCoord(place.lat, place.lng)) return [];
    const lat = Number(place.lat).toFixed(6);
    const lng = Number(place.lng).toFixed(6);
    const encodedName = encodeURIComponent(place.name || `${lat},${lng}`);

    return [
        {
            id: 'google',
            label: 'Google Maps',
            url: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
        },
        {
            id: 'apple',
            label: 'Apple Maps',
            url: `https://maps.apple.com/?ll=${lat},${lng}&q=${encodedName}`,
        },
        {
            id: 'comaps',
            label: 'CoMaps',
            url: `comaps://map?v=1&ll=${lat},${lng}&n=${encodedName}`,
        },
        {
            id: 'organic',
            label: 'Organic Maps',
            url: `om://map?v=1&ll=${lat},${lng}&n=${encodedName}`,
        },
        {
            id: 'osmand',
            label: 'OsmAnd',
            url: `https://osmand.net/go?lat=${lat}&lon=${lng}&z=16`,
        },
        {
            id: 'waze',
            label: 'Waze',
            url: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
        },
        {
            id: 'osm',
            label: 'OpenStreetMap',
            url: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`,
        },
    ];
}

/**
 * Generate a multi-stop day route URL for Google Maps or CoMaps.
 * @param {Array<{ lat: number, lng: number, name?: string }>} places
 * @param {'driving' | 'walking' | 'transit' | 'bicycling'} [mode='driving']
 */
export function getDayNavigationLinks(places = [], mode = 'driving') {
    const valid = places.filter((p) => isValidCoord(p?.lat, p?.lng));
    if (valid.length === 0) return { googleMapsUrl: null, coMapsUrl: null };

    if (valid.length === 1) {
        const p = valid[0];
        return {
            googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`,
            coMapsUrl: `comaps://map?v=1&ll=${p.lat},${p.lng}&n=${encodeURIComponent(p.name || 'Stop')}`,
        };
    }

    const origin = `${valid[0].lat},${valid[0].lng}`;
    const dest = `${valid[valid.length - 1].lat},${valid[valid.length - 1].lng}`;
    const waypoints = valid.slice(1, -1).map((p) => `${p.lat},${p.lng}`).join('|');

    const travelModeMap = {
        driving: 'driving',
        walking: 'walking',
        transit: 'transit',
        bicycling: 'bicycling',
        cycling: 'bicycling',
    };
    const gMode = travelModeMap[mode] || 'driving';

    const googleMapsUrl = waypoints
        ? `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&waypoints=${encodeURIComponent(waypoints)}&travelmode=${gMode}`
        : `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=${gMode}`;

    const coMapsType = gMode === 'walking' ? 'pedestrian' : gMode === 'bicycling' ? 'bicycle' : gMode === 'transit' ? 'transit' : 'vehicle';
    const coMapsUrl = `comaps://route?sll=${valid[0].lat},${valid[0].lng}&saddr=${encodeURIComponent(valid[0].name || 'Start')}&dll=${valid[valid.length - 1].lat},${valid[valid.length - 1].lng}&daddr=${encodeURIComponent(valid[valid.length - 1].name || 'End')}&type=${coMapsType}`;

    return { googleMapsUrl, coMapsUrl };
}
