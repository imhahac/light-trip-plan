/**
 * placeSearchService.js
 * 地點搜尋、視角 POI 探索與維基百科圖文富化服務
 * 1. OSM Nominatim 地點搜尋 (免 Key)
 * 2. Overpass API 視野 POI 景點/美食探索 (免 Key)
 * 3. Wikipedia / Wikimedia 景點圖文富化 (免 Key)
 */

import { logger } from '../../utils/logger';
import { isEffectivelyOffline } from '../sync/offlineModeService';

/**
 * OpenStreetMap Nominatim 地點搜尋
 */
export async function searchPlaces(query) {
    if (!query || typeof query !== 'string' || !query.trim()) return [];
    const q = query.trim();

    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=8`;

    try {
        const res = await fetch(url, {
            headers: {
                'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8,ja;q=0.7',
                'User-Agent': 'TREKLite-Planner/1.0'
            }
        });
        if (!res.ok) return [];
        const items = await res.json();

        return items.map(item => ({
            id: `osm_${item.place_id}`,
            name: item.name || item.display_name.split(',')[0],
            displayName: item.display_name,
            lat: parseFloat(item.lat),
            lng: parseFloat(item.lon),
            category: item.type || item.class || 'place',
            address: item.display_name
        }));
    } catch (err) {
        logger.error('Nominatim place search failed:', err);
        return [];
    }
}

/**
 * 透過 Overpass API 抓取當前地圖視角 (Bounding Box) 內的熱門景點與美食
 * @param {{south: number, west: number, north: number, east: number}} bbox
 * @param {'sights' | 'food' | 'lodging' | 'transit'} category
 */
const POI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const OVERPASS_MIN_INTERVAL_MS = 1500;
const OVERPASS_MAX_BBOX_SPAN_DEG = 1.5;
const poiCache = new Map();
const wikiCache = new Map();
let lastOverpassCallAt = 0;

/**
 * 透過 Overpass API 抓取當前地圖視角 (Bounding Box) 內的熱門景點與美食
 * 具備 1.5s 節流防護、BBox 面積保護、10s Timeout 與 24h 快取
 * @param {{south: number, west: number, north: number, east: number}} bbox
 * @param {'sights' | 'food' | 'lodging' | 'transit' | 'convenience' | 'toilets'} category
 */
export async function fetchViewportPOIs(bbox, category = 'sights', limit = 25) {
    if (!bbox) return [];

    const { south, west, north, east } = bbox;
    if (Math.abs(north - south) > OVERPASS_MAX_BBOX_SPAN_DEG || Math.abs(east - west) > OVERPASS_MAX_BBOX_SPAN_DEG) {
        logger.warn('Overpass BBox too large; zoom in to explore POIs');
        return [];
    }

    const cacheKey = `${category}:${south.toFixed(3)},${west.toFixed(3)},${north.toFixed(3)},${east.toFixed(3)}`;
    const cached = poiCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < POI_CACHE_TTL_MS) {
        return cached.items;
    }
    if (isEffectivelyOffline()) {
        return cached?.items || [];
    }

    const now = Date.now();
    if (now - lastOverpassCallAt < OVERPASS_MIN_INTERVAL_MS) {
        return cached?.items || [];
    }
    lastOverpassCallAt = now;

    let filterTag = '["tourism"~"attraction|museum|viewpoint"]';
    if (category === 'food') {
        filterTag = '["amenity"~"restaurant|cafe|bar"]';
    } else if (category === 'lodging') {
        filterTag = '["tourism"="hotel"]';
    } else if (category === 'transit') {
        filterTag = '["railway"~"station|subway_entrance"]';
    } else if (category === 'convenience') {
        filterTag = '["shop"~"convenience|supermarket"]';
    } else if (category === 'toilets') {
        filterTag = '["amenity"="toilets"]';
    }

    const overpassQuery = `
        [out:json][timeout:10];
        (
            node${filterTag}(${south},${west},${north},${east});
        );
        out body ${limit};
    `;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: overpassQuery,
            signal: controller.signal,
        });
        if (!res.ok) return [];
        const data = await res.json();

        const items = (data.elements || []).map(el => ({
            id: `poi_${el.id}`,
            name: el.tags?.['name:zh'] || el.tags?.name || el.tags?.['name:en'] || '未知名稱',
            lat: el.lat,
            lng: el.lon,
            category: category,
            tags: el.tags || {},
            openingHours: el.tags?.opening_hours || null
        }));
        poiCache.set(cacheKey, { ts: Date.now(), items });
        return items;
    } catch (err) {
        logger.warn('Overpass POI query failed or timed out:', err);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 抓取維基百科 / Wikidata 景點介紹與封面圖（含本地記憶體快取）
 * @param {string} placeName
 */
export async function enrichPlaceWithWikipedia(placeName) {
    if (!placeName) return null;
    const cleanTitle = placeName.split('(')[0].split('（')[0].trim();
    if (!cleanTitle) return null;

    const cacheKey = cleanTitle.toLowerCase();
    if (wikiCache.has(cacheKey)) {
        return wikiCache.get(cacheKey);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
        // 先嘗試中文維基，失敗則嘗試英文與日文維基
        let res = await fetch(`https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanTitle)}`, { signal: controller.signal });
        if (!res.ok) {
            res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanTitle)}`, { signal: controller.signal });
        }
        if (!res.ok) {
            res = await fetch(`https://ja.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanTitle)}`, { signal: controller.signal });
        }
        if (!res.ok) {
            wikiCache.set(cacheKey, null);
            return null;
        }

        const data = await res.json();
        const result = {
            title: data.title,
            description: data.extract || null,
            thumbnailUrl: data.thumbnail?.source || null,
            pageUrl: data.content_urls?.desktop?.page || null,
            wikidataId: data.wikibase_item || null,
        };
        wikiCache.set(cacheKey, result);
        return result;
    } catch (err) {
        logger.warn('Wikipedia enrichment failed:', err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}
