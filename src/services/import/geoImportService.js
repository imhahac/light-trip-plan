/**
 * geoImportService.js
 * 純前端外部景點與軌跡匯入解析引擎：
 * 1. GPX (XML DOMParser 解析 <wpt> 與 <trkpt>)
 * 2. KML (XML DOMParser 解析 <Placemark> 與 <coordinates>)
 * 3. KMZ (JSZip 解壓縮 doc.kml 後呼叫 KML 解析器)
 * 4. Google Maps & Naver Maps 分享連結與經緯度智慧解析
 */

/**
 * 解析 GPX XML 字串為景點清單
 * @param {string} gpxText
 * @returns {Array<{ name: string, lat: number, lng: number, desc?: string, ele?: number }>}
 */
export function parseGpx(gpxText) {
    if (!gpxText || typeof gpxText !== 'string') return [];

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(gpxText, 'text/xml');

    // 檢查 XML 解析錯誤
    const parseError = xmlDoc.querySelector('parsererror');
    if (parseError) {
        throw new Error('GPX 格式錯誤，無法解析 XML');
    }

    const places = [];

    // 1. 優先讀取獨立航點 <wpt>
    const waypoints = xmlDoc.querySelectorAll('wpt');
    waypoints.forEach(wpt => {
        const lat = parseFloat(wpt.getAttribute('lat'));
        const lon = parseFloat(wpt.getAttribute('lon'));
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const name = wpt.querySelector('name')?.textContent?.trim() || '未命名航點';
            const desc = wpt.querySelector('desc')?.textContent?.trim() || wpt.querySelector('cmt')?.textContent?.trim() || '';
            const ele = parseFloat(wpt.querySelector('ele')?.textContent) || null;

            places.push({
                name,
                lat,
                lng: lon,
                desc,
                ele,
                source: 'gpx_wpt'
            });
        }
    });

    // 2. 若無 <wpt>，嘗試抽取 <rtept> (路線點) 或間隔抽樣 <trkpt> (軌跡點)
    if (places.length === 0) {
        const routePoints = xmlDoc.querySelectorAll('rtept');
        routePoints.forEach((rpt, idx) => {
            const lat = parseFloat(rpt.getAttribute('lat'));
            const lon = parseFloat(rpt.getAttribute('lon'));
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                places.push({
                    name: rpt.querySelector('name')?.textContent?.trim() || `路線點 #${idx + 1}`,
                    lat,
                    lng: lon,
                    source: 'gpx_rtept'
                });
            }
        });
    }

    return places;
}

/**
 * 解析 KML XML 字串為景點清單
 * @param {string} kmlText
 * @returns {Array<{ name: string, lat: number, lng: number, desc?: string }>}
 */
export function parseKml(kmlText) {
    if (!kmlText || typeof kmlText !== 'string') return [];

    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(kmlText, 'text/xml');

    const parseError = xmlDoc.querySelector('parsererror');
    if (parseError) {
        throw new Error('KML 格式錯誤，無法解析 XML');
    }

    const places = [];
    const placemarks = xmlDoc.querySelectorAll('Placemark');

    placemarks.forEach(pm => {
        const name = pm.querySelector('name')?.textContent?.trim() || '未命名地標';
        const desc = pm.querySelector('description')?.textContent?.trim() || '';
        const coordsText = pm.querySelector('coordinates')?.textContent?.trim() || '';

        if (coordsText) {
            // KML coordinates 格式: "lon,lat,ele" 或 "lon,lat"
            const firstCoord = coordsText.split(/\s+/)[0];
            const parts = firstCoord.split(',');
            if (parts.length >= 2) {
                const lon = parseFloat(parts[0]);
                const lat = parseFloat(parts[1]);
                const ele = parts.length > 2 ? parseFloat(parts[2]) : null;

                if (Number.isFinite(lat) && Number.isFinite(lon)) {
                    places.push({
                        name,
                        lat,
                        lng: lon,
                        desc,
                        ele: Number.isFinite(ele) ? ele : undefined,
                        source: 'kml'
                    });
                }
            }
        }
    });

    return places;
}

/**
 * 純前端解壓縮 KMZ 檔案並解析其中的 doc.kml
 * @param {File | Blob} file
 * @returns {Promise<Array<{ name: string, lat: number, lng: number, desc?: string }>>}
 */
export async function parseKmz(file) {
    const JSZipModule = await import('jszip');
    const JSZip = JSZipModule.default || JSZipModule;
    const zip = await JSZip.loadAsync(file);

    // 尋找主 kml 檔案 (通常是 doc.kml 或任意 .kml)
    let kmlFileName = Object.keys(zip.files).find(name => name.toLowerCase() === 'doc.kml');
    if (!kmlFileName) {
        kmlFileName = Object.keys(zip.files).find(name => name.toLowerCase().endsWith('.kml'));
    }

    if (!kmlFileName) {
        throw new Error('KMZ 封裝檔案中未找到有效的 .kml 地圖資料');
    }

    const kmlContent = await zip.files[kmlFileName].async('text');
    return parseKml(kmlContent);
}

/**
 * 智慧解析文字內容中的 Google Maps 與 Naver Maps 連結及純經緯度
 * 支援多行文字批次解析
 * @param {string} text
 * @returns {Array<{ name: string, lat: number, lng: number, source: string, originalUrl?: string }>}
 */
import { searchPlaces } from '../places/placeSearchService';

/**
 * 同步解析文字中直接包含經緯度之地圖連結或座標
 * @param {string} text
 * @returns {Array<{ name: string, lat: number, lng: number, source: string, originalUrl?: string }>}
 */
export function parseMapLinksSync(text) {
    if (!text || typeof text !== 'string') return [];

    const results = [];
    const lines = text.split(/[\r\n]+/);

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // 1. Apple Maps 連結: maps.apple.com 含 ll=(lat),(lng)
        if (line.includes('maps.apple.com')) {
            const appleCoordMatch = line.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
            if (appleCoordMatch) {
                const qMatch = line.match(/[?&]q=([^&#]+)/);
                const name = qMatch ? decodeURIComponent(qMatch[1].replace(/\+/g, ' ')) : 'Apple Maps 地標';
                results.push({
                    name,
                    lat: parseFloat(appleCoordMatch[1]),
                    lng: parseFloat(appleCoordMatch[2]),
                    source: 'apple_maps',
                    originalUrl: line
                });
                continue;
            }
        }

        // 2. Naver Maps 連結: map.naver.com 含有經緯度 (lng,lat 或 lat,lng)
        if (line.includes('naver.com')) {
            const naverMatch = line.match(/lng=(-?\d+\.\d+).*?lat=(-?\d+\.\d+)/) ||
                               line.match(/lat=(-?\d+\.\d+).*?lng=(-?\d+\.\d+)/);
            if (naverMatch) {
                const lat = parseFloat(line.includes('lat=') ? line.match(/lat=(-?\d+\.\d+)/)[1] : naverMatch[2]);
                const lng = parseFloat(line.includes('lng=') ? line.match(/lng=(-?\d+\.\d+)/)[1] : naverMatch[1]);
                results.push({
                    name: 'Naver Map 景點',
                    lat,
                    lng,
                    source: 'naver_maps',
                    originalUrl: line
                });
                continue;
            }
        }

        // 3. Google Maps: /place/(Name)/@(lat),(lng)
        const gPlaceCoordMatch = line.match(/\/place\/([^/@?]+).*?@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (gPlaceCoordMatch) {
            const rawName = gPlaceCoordMatch[1].replace(/\+/g, ' ');
            const lat = parseFloat(gPlaceCoordMatch[2]);
            const lng = parseFloat(gPlaceCoordMatch[3]);
            results.push({
                name: decodeURIComponent(rawName),
                lat,
                lng,
                source: 'google_maps',
                originalUrl: line
            });
            continue;
        }

        // 3.1 Google Maps Protobuf 嵌入坐標: !3d(lat)!4d(lng)
        const gProtoMatch = line.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
        if (gProtoMatch) {
            const placeMatch = line.match(/\/place\/([^/@?]+)/);
            const rawName = placeMatch ? placeMatch[1].replace(/\+/g, ' ') : 'Google Maps 地標';
            results.push({
                name: decodeURIComponent(rawName),
                lat: parseFloat(gProtoMatch[1]),
                lng: parseFloat(gProtoMatch[2]),
                source: 'google_maps',
                originalUrl: line
            });
            continue;
        }

        // 3.2 Google Maps query / ll 帶經緯度: ?q=(lat),(lng) 或 ?query=(lat),(lng) 或 ?ll=(lat),(lng)
        const gQueryMatch = line.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (gQueryMatch && (line.includes('google.com') || line.includes('goo.gl') || !line.startsWith('http'))) {
            const placeMatch = line.match(/\/place\/([^/@?]+)/);
            const rawName = placeMatch 
                ? decodeURIComponent(placeMatch[1].replace(/\+/g, ' '))
                : `Google Maps 地標 (${gQueryMatch[1]}, ${gQueryMatch[2]})`;
            results.push({
                name: rawName,
                lat: parseFloat(gQueryMatch[1]),
                lng: parseFloat(gQueryMatch[2]),
                source: 'google_maps',
                originalUrl: line
            });
            continue;
        }

        // 3.3 純 Google Maps 視角坐標: @(lat),(lng),
        const gAtCoordMatch = line.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
        if (gAtCoordMatch && (line.includes('google.com') || line.includes('goo.gl'))) {
            const placeMatch = line.match(/\/place\/([^/@?]+)/);
            const rawName = placeMatch 
                ? decodeURIComponent(placeMatch[1].replace(/\+/g, ' '))
                : `Google Maps 視角坐標`;
            results.push({
                name: rawName,
                lat: parseFloat(gAtCoordMatch[1]),
                lng: parseFloat(gAtCoordMatch[2]),
                source: 'google_maps',
                originalUrl: line
            });
            continue;
        }

        // 6. 寬鬆純經緯度輸入 (支援 "(25.033964, 121.564472)"、"東京鐵塔 35.6586, 139.7454")
        const coordsRegex = /(?:^|[\s(,;])([+-]?\d{1,3}\.\d+)[,\s]+([+-]?\d{1,3}\.\d+)(?:[\s),;]|$)/;
        const coordsMatch = line.match(coordsRegex);
        if (coordsMatch) {
            const lat = parseFloat(coordsMatch[1]);
            const lng = parseFloat(coordsMatch[2]);
            if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                let placeName = line.replace(coordsRegex, ' ').replace(/[()，,]/g, '').trim();
                if (!placeName || placeName.length < 2) {
                    placeName = `經緯度座標 (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                }
                results.push({
                    name: placeName,
                    lat,
                    lng,
                    source: 'raw_coords',
                    originalUrl: line
                });
                continue;
            }
        }
    }

    return results;
}

/**
 * 嘗試將 Google Maps 短網址 (maps.app.goo.gl 或 goo.gl/maps) 展開為完整包含地標名稱與經緯度的 URL
 * 優先使用本地/部署的 Cloudflare Worker 代理，備援使用 unshorten.me 公用 CORS API
 * @param {string} shortUrl
 * @returns {Promise<string|null>}
 */
export async function resolveGoogleMapsShortUrl(shortUrl) {
    if (!shortUrl || typeof shortUrl !== 'string') return null;

    // 1. 若環境有設定 Worker 代理，優先走邊緣節點展開
    const proxyBase = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FLIGHT_PROXY_URL) || '';
    if (proxyBase) {
        try {
            const workerUrl = `${proxyBase.replace(/\/+$/, '')}?api=unshorten&url=${encodeURIComponent(shortUrl)}`;
            const res = await fetch(workerUrl, { signal: AbortSignal.timeout(4000) });
            if (res.ok) {
                const data = await res.json();
                if (data && data.resolvedUrl) {
                    let cleaned = data.resolvedUrl;
                    if (cleaned.includes('continue=')) {
                        const m = cleaned.match(/continue=([^&]+)/);
                        if (m) cleaned = decodeURIComponent(m[1]);
                    }
                    return cleaned;
                }
            }
        } catch {
            // Worker 請求超時或未部署，繼續往下走備援
        }
    }

    // 2. 備援：使用公開支援 CORS 的 unshorten.me API
    try {
        const unshortenApi = `https://unshorten.me/json/${encodeURIComponent(shortUrl)}`;
        const res = await fetch(unshortenApi, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
            const data = await res.json();
            if (data && data.success && data.resolved_url) {
                let cleaned = data.resolved_url;
                if (cleaned.includes('continue=')) {
                    const m = cleaned.match(/continue=([^&]+)/);
                    if (m) cleaned = decodeURIComponent(m[1]);
                }
                return cleaned;
            }
        }
    } catch {
        // 忽略連線失敗
    }

    return null;
}

/**
 * 智慧非同步解析文字中的地圖連結、經緯度或景點名稱
 * 當輸入缺乏直接座標時，自動從分享文字萃取名稱並透過 Nominatim 聯網定位
 * @param {string} text
 * @returns {Promise<Array<{ name: string, lat: number, lng: number, source: string, originalUrl?: string, address?: string }>>}
 */
export async function parseMapLinks(text) {
    if (!text || typeof text !== 'string') return [];

    // 1. 先執行同步提取已知座標
    const directResults = parseMapLinksSync(text);

    // 2. 找出未直接匹配出座標但包含地名、短網址或分享連結的行
    const lines = text.split(/[\r\n]+/);
    const searchTasks = [];
    const shortUrlTasks = [];
    const directUrls = new Set(directResults.map(r => r.originalUrl).filter(Boolean));

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || directUrls.has(line)) continue;

        let placeName = '';
        const originalUrl = line;

        // 偵測 Google Maps 短網址 (maps.app.goo.gl 或 goo.gl/maps)
        const shortUrlMatch = line.match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/[A-Za-z0-9_-]+/i);

        // 模式 A: 手機 Google Maps 分享文字: 在 Google 地圖上查看「(名稱)」：https://...
        const shareTitleMatch = line.match(/(?:在\s*Google\s*地圖上)?查看[「『"“](.*?)[」』"”]/i) ||
                                line.match(/^[「『"“](.*?)[」』"”]/);
        if (shareTitleMatch) {
            placeName = shareTitleMatch[1].trim();
        } else {
            // 模式 B: (名稱) https://maps.app.goo.gl/... 或 https://goo.gl/maps/...
            const shortShareMatch = line.match(/^(.*?)\s+https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com|www\.google\.com\/maps)/i);
            if (shortShareMatch && shortShareMatch[1].trim().length >= 2) {
                placeName = shortShareMatch[1].replace(/[「」『』"“”]/g, '').trim();
            }
        }

        // 模式 C: 若有短網址但無法直接從行內取得有效景點名稱，加入短網址還原排程
        if (!placeName && shortUrlMatch) {
            shortUrlTasks.push({ shortUrl: shortUrlMatch[0], originalLine: line });
            continue;
        }

        // 模式 D: Google Maps 搜尋或 Place 連結 (不含座標)
        if (!placeName && line.includes('google.com/maps')) {
            const searchParamMatch = line.match(/[?&]query=([^&#]+)/) ||
                                     line.match(/\/maps\/search\/([^/?&#]+)/);
            if (searchParamMatch) {
                placeName = decodeURIComponent(searchParamMatch[1].replace(/\+/g, ' ')).trim();
            } else {
                const placePathMatch = line.match(/\/maps\/place\/([^/@?&#]+)/);
                if (placePathMatch) {
                    placeName = decodeURIComponent(placePathMatch[1].replace(/\+/g, ' ')).trim();
                }
            }
        }

        // 模式 E: Apple Maps 搜尋連結
        if (!placeName && line.includes('maps.apple.com')) {
            const appleQMatch = line.match(/[?&]q=([^&#]+)/);
            if (appleQMatch) {
                placeName = decodeURIComponent(appleQMatch[1].replace(/\+/g, ' ')).trim();
            }
        }

        // 模式 F: 純景點名稱文字 (不含 http:// 或 https://，長度 2 ~ 40 字)
        if (!placeName && !line.includes('http://') && !line.includes('https://') && line.length >= 2 && line.length <= 40) {
            if (!/^[0-9\s,.-]+$/.test(line)) {
                placeName = line.replace(/^[0-9]+[.\-、\s]+/, '').trim();
            }
        }

        if (placeName && placeName.length >= 2) {
            searchTasks.push({ name: placeName, originalUrl });
        }
    }

    const resolvedResults = [...directResults];

    // 3. 處理短網址還原
    if (shortUrlTasks.length > 0) {
        const shortUrlPromises = shortUrlTasks.map(async task => {
            const expandedUrl = await resolveGoogleMapsShortUrl(task.shortUrl);
            if (expandedUrl) {
                // 將展開後的 URL 嘗試直接同步抽取
                const extracted = parseMapLinksSync(expandedUrl);
                if (extracted.length > 0) {
                    return extracted.map(item => ({
                        ...item,
                        originalUrl: task.originalLine
                    }));
                }
                // 若只拿到 place 路徑中的地名但無經緯度
                const placeMatch = expandedUrl.match(/\/place\/([^/@?&#]+)/);
                if (placeMatch) {
                    const fallbackName = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
                    if (fallbackName) {
                        return [{ fallbackSearch: fallbackName, originalUrl: task.originalLine }];
                    }
                }
            }
            return null;
        });

        const shortUrlResults = await Promise.all(shortUrlPromises);
        shortUrlResults.flat().forEach(item => {
            if (!item) return;
            if (item.fallbackSearch) {
                searchTasks.push({ name: item.fallbackSearch, originalUrl: item.originalUrl });
            } else {
                resolvedResults.push(item);
            }
        });
    }

    // 4. 透過 Nominatim 聯網並行搜尋解析真實座標
    const searchedNames = new Set(resolvedResults.map(r => r.name.toLowerCase()));

    if (searchTasks.length > 0) {
        const uniqueTasks = [];
        for (const t of searchTasks) {
            if (!searchedNames.has(t.name.toLowerCase())) {
                searchedNames.add(t.name.toLowerCase());
                uniqueTasks.push(t);
            }
        }

        const searchPromises = uniqueTasks.slice(0, 10).map(async task => {
            try {
                const candidates = await searchPlaces(task.name);
                if (candidates && candidates.length > 0) {
                    const top = candidates[0];
                    return {
                        name: task.name,
                        lat: top.lat,
                        lng: top.lng,
                        address: top.address || top.displayName || '',
                        source: 'search_place',
                        originalUrl: task.originalUrl
                    };
                }
            } catch {
                // 忽略個別網路問題
            }
            return null;
        });

        const foundPlaces = await Promise.all(searchPromises);
        foundPlaces.forEach(p => {
            if (p) resolvedResults.push(p);
        });
    }

    return resolvedResults;
}

/**
 * 計算兩點間 Haversine 球面距離 (km)
 */
function trackHaversineKm(lat1, lng1, lat2, lng2) {
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
 * 解析 GPX <trkpt> 完整軌跡與海拔剖面統計（供 Light Tours 高度剖面圖與計畫 vs 實錄對比）
 * 支援瀏覽器 DOMParser 與 Node.js 正規表示式降級解析
 * @param {string} gpxText
 */
export function parseGpxTrack(gpxText) {
    if (!gpxText || typeof gpxText !== 'string') {
        return { name: '', points: [], sampledPoints: [], totalDistanceKm: 0, totalAscentM: 0, totalDescentM: 0, minEleM: null, maxEleM: null, durationMin: null };
    }

    const rawPoints = [];
    let trackName = '';

    if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(gpxText, 'text/xml');
        if (xmlDoc.querySelector('parsererror')) {
            throw new Error('GPX 格式錯誤，無法解析 XML');
        }
        trackName = xmlDoc.querySelector('trk > name')?.textContent?.trim()
            || xmlDoc.querySelector('metadata > name')?.textContent?.trim()
            || '';
        const trkpts = xmlDoc.querySelectorAll('trkpt');
        const nodes = trkpts.length > 0 ? trkpts : xmlDoc.querySelectorAll('rtept');
        nodes.forEach((pt) => {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lng = parseFloat(pt.getAttribute('lon'));
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            const eleText = pt.querySelector('ele')?.textContent;
            const ele = eleText != null && Number.isFinite(parseFloat(eleText)) ? parseFloat(eleText) : null;
            const timeText = pt.querySelector('time')?.textContent?.trim() || null;
            rawPoints.push({ lat, lng, ele, time: timeText });
        });
    } else {
        const nameMatch = gpxText.match(/<trk>[\s\S]*?<name>([^<]+)<\/name>/i);
        if (nameMatch) trackName = nameMatch[1].trim();
        const ptRegex = /<(?:trkpt|rtept)\s+[^>]*lat=["']([^"']+)["'][^>]*lon=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:trkpt|rtept)>/gi;
        let m;
        while ((m = ptRegex.exec(gpxText)) !== null) {
            const lat = parseFloat(m[1]);
            const lng = parseFloat(m[2]);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
            const eleMatch = m[3].match(/<ele>([^<]+)<\/ele>/i);
            const timeMatch = m[3].match(/<time>([^<]+)<\/time>/i);
            rawPoints.push({
                lat,
                lng,
                ele: eleMatch && Number.isFinite(parseFloat(eleMatch[1])) ? parseFloat(eleMatch[1]) : null,
                time: timeMatch ? timeMatch[1].trim() : null,
            });
        }
    }

    let totalDistanceKm = 0;
    let totalAscentM = 0;
    let totalDescentM = 0;
    let minEleM = null;
    let maxEleM = null;

    const enriched = rawPoints.map((pt, idx) => {
        if (idx > 0) {
            const prev = rawPoints[idx - 1];
            totalDistanceKm += trackHaversineKm(prev.lat, prev.lng, pt.lat, pt.lng);
            if (prev.ele !== null && pt.ele !== null) {
                const diff = pt.ele - prev.ele;
                // 2m noise filter for GPS elevation jitter
                if (diff > 2) totalAscentM += diff;
                else if (diff < -2) totalDescentM += Math.abs(diff);
            }
        }
        if (pt.ele !== null) {
            minEleM = minEleM === null ? pt.ele : Math.min(minEleM, pt.ele);
            maxEleM = maxEleM === null ? pt.ele : Math.max(maxEleM, pt.ele);
        }
        return {
            ...pt,
            distKm: Number(totalDistanceKm.toFixed(2)),
        };
    });

    let durationMin = null;
    if (enriched.length >= 2 && enriched[0].time && enriched[enriched.length - 1].time) {
        const t0 = Date.parse(enriched[0].time);
        const t1 = Date.parse(enriched[enriched.length - 1].time);
        if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) {
            durationMin = Math.round((t1 - t0) / 60000);
        }
    }

    // Downsample to <= 120 points for fast Recharts rendering
    const maxSamples = 120;
    let sampledPoints = enriched;
    if (enriched.length > maxSamples) {
        const step = (enriched.length - 1) / (maxSamples - 1);
        sampledPoints = Array.from({ length: maxSamples }, (_, i) => enriched[Math.round(i * step)]);
    }

    return {
        name: trackName,
        points: enriched,
        sampledPoints,
        totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
        totalAscentM: Math.round(totalAscentM),
        totalDescentM: Math.round(totalDescentM),
        minEleM: minEleM !== null ? Math.round(minEleM) : null,
        maxEleM: maxEleM !== null ? Math.round(maxEleM) : null,
        durationMin,
    };
}

/**
 * 將 GPX 軌跡點轉為依海拔坡度著色的 GeoJSON FeatureCollection
 * - 下坡 (< -4%): 天藍 (#0284c7)
 * - 平緩 (-4% ~ 4%): 翡翠綠 (#10b981)
 * - 中坡 (4% ~ 10%): 琥珀橘 (#f59e0b)
 * - 陡坡 (> 10%): 玫瑰紅 (#e11d48)
 */
export function buildGradedTrackGeoJson(points = []) {
    if (!Array.isArray(points) || points.length < 2) {
        return { type: 'FeatureCollection', features: [] };
    }
    const features = [];
    for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const distM = trackHaversineKm(prev.lat, prev.lng, curr.lat, curr.lng) * 1000;
        let gradePct = 0;
        if (prev.ele != null && curr.ele != null && distM > 1) {
            gradePct = ((curr.ele - prev.ele) / distM) * 100;
        }
        let gradeColor = '#10b981';
        if (gradePct > 10) gradeColor = '#e11d48';
        else if (gradePct > 4) gradeColor = '#f59e0b';
        else if (gradePct < -4) gradeColor = '#0284c7';

        features.push({
            type: 'Feature',
            properties: {
                gradePct: Math.round(gradePct * 10) / 10,
                gradeColor,
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [Number(prev.lng), Number(prev.lat)],
                    [Number(curr.lng), Number(curr.lat)],
                ],
            },
        });
    }
    return { type: 'FeatureCollection', features };
}

/**
 * 比較「計畫 GPX」與「實錄 GPX」的里程、爬升與耗時差異
 */
export function compareGpxTracks(planned, recorded) {
    if (!planned || !recorded) return null;
    const distanceDeltaKm = Number(((recorded.totalDistanceKm || 0) - (planned.totalDistanceKm || 0)).toFixed(2));
    const ascentDeltaM = Math.round((recorded.totalAscentM || 0) - (planned.totalAscentM || 0));
    const durationDeltaMin = (recorded.durationMin != null && planned.durationMin != null)
        ? recorded.durationMin - planned.durationMin
        : null;
    return {
        distanceDeltaKm,
        ascentDeltaM,
        durationDeltaMin,
    };
}

/**
 * 解析 Google Takeout 匯出的「已儲存地點」CSV (Title, Note, URL, Tags, Comment)
 * @param {string} csvText
 */
export function parseGoogleTakeoutCsv(csvText) {
    if (!csvText || typeof csvText !== 'string') return [];
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];

    const parseCsvRow = (row) => {
        const out = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < row.length; i++) {
            const ch = row[i];
            if (ch === '"') {
                if (inQuotes && row[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === ',' && !inQuotes) {
                out.push(cur.trim());
                cur = '';
            } else {
                cur += ch;
            }
        }
        out.push(cur.trim());
        return out;
    };

    const headers = parseCsvRow(lines[0]).map((h) => h.toLowerCase());
    const titleIdx = headers.findIndex((h) => h === 'title' || h === 'name' || h === '名稱');
    const noteIdx = headers.findIndex((h) => h === 'note' || h === 'comment' || h === '備註');
    const urlIdx = headers.findIndex((h) => h === 'url' || h === 'link');
    if (titleIdx === -1) return [];

    const results = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvRow(lines[i]);
        const name = cols[titleIdx];
        if (!name) continue;
        const url = urlIdx >= 0 ? cols[urlIdx] || '' : '';
        const coordMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
        results.push({
            name,
            desc: noteIdx >= 0 ? cols[noteIdx] || '' : '',
            originalUrl: url,
            lat: coordMatch ? parseFloat(coordMatch[1]) : null,
            lng: coordMatch ? parseFloat(coordMatch[2]) : null,
            source: 'google_takeout_csv',
        });
    }
    return results;
}

/**
 * 統一檔案匯入接口：依據副檔名解析 GPX, KML, KMZ, CSV (Google Takeout)
 * @param {File} file
 * @returns {Promise<Array<{ name: string, lat: number, lng: number, desc?: string }>>}
 */
export async function parseGeoFile(file) {
    if (!file) return [];
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith('.kmz')) {
        return parseKmz(file);
    }

    const text = await file.text();
    if (fileName.endsWith('.gpx')) {
        return parseGpx(text);
    } else if (fileName.endsWith('.kml')) {
        return parseKml(text);
    } else if (fileName.endsWith('.csv')) {
        return parseGoogleTakeoutCsv(text);
    } else {
        throw new Error(`不支援的檔案格式：${file.name} (僅支援 .gpx, .kml, .kmz, .csv)`);
    }
}
