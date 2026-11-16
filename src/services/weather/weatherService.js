/**
 * weatherService.js
 * Open-Meteo 16 天即時天氣預報與歷史同日氣候回溯服務 (免 Key)
 */

import { logger } from '../../utils/logger';

export const WMO_WEATHER_MAP = {
    0: { label: '晴朗', icon: '☀️' },
    1: { label: '主要晴朗', icon: '🌤️' },
    2: { label: '多雲', icon: '⛅' },
    3: { label: '陰天', icon: '☁️' },
    45: { label: '有霧', icon: '🌫️' },
    48: { label: '霧淞', icon: '🌫️' },
    51: { label: '細雨', icon: '🌦️' },
    53: { label: '小雨', icon: '🌧️' },
    55: { label: '濃密小雨', icon: '🌧️' },
    61: { label: '小陣雨', icon: '🌧️' },
    63: { label: '中雨', icon: '🌧️' },
    65: { label: '豪大雨', icon: '⛈️' },
    71: { label: '小雪', icon: '🌨️' },
    73: { label: '中雪', icon: '❄️' },
    75: { label: '大雪', icon: '❄️' },
    80: { label: '陣雨', icon: '🌦️' },
    81: { label: '強烈陣雨', icon: '🌧️' },
    82: { label: '劇烈陣雨', icon: '⛈️' },
    95: { label: '雷雨', icon: '⛈️' },
    96: { label: '雷雨伴隨冰雹', icon: '⛈️' }
};

export function getWeatherInfo(code) {
    return WMO_WEATHER_MAP[code] || { label: '陰晴不一', icon: '🌤️' };
}

/**
 * 具備逾時保護的 fetch 封裝，避免單一端點連線卡死
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 備援即時預報：當 Open-Meteo 即時預報端點連線逾時或限流時，自動切換至 MET Norway 全球即時氣象 API (免 Key)
 */
async function fetchMetNoForecastFallback(lat, lng, targetDate) {
    try {
        const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`;
        const res = await fetchWithTimeout(url, {
            headers: { 'User-Agent': 'LightTripPlan/1.0 (https://github.com/reverse-ticket-manager)' }
        }, 4500);
        if (!res.ok) return null;
        const data = await res.json();
        const series = data?.properties?.timeseries;
        if (!Array.isArray(series) || series.length === 0) return null;

        // 篩選目標日期的時段，若無完全吻合則取最接近的 24 小時區間
        const dayEntries = series.filter(item => item.time && item.time.startsWith(targetDate));
        const targetEntries = dayEntries.length > 0 ? dayEntries : series.slice(0, 8);

        const temps = targetEntries
            .map(item => item.data?.instant?.details?.air_temperature)
            .filter(t => typeof t === 'number');
        if (temps.length === 0) return null;

        const precipAmounts = targetEntries.map(item =>
            item.data?.next_6_hours?.details?.precipitation_amount ??
            item.data?.next_1_hours?.details?.precipitation_amount ??
            0
        );
        const totalPrecip = precipAmounts.reduce((a, b) => a + b, 0);
        const symbol = targetEntries.find(item => item.data?.next_6_hours?.summary?.symbol_code)?.data?.next_6_hours?.summary?.symbol_code
            || targetEntries[0]?.data?.next_1_hours?.summary?.symbol_code
            || '';

        let wmoCode = 1;
        if (symbol.includes('clearsky') || symbol.includes('fair')) wmoCode = 0;
        else if (symbol.includes('partlycloudy')) wmoCode = 2;
        else if (symbol.includes('cloudy')) wmoCode = 3;
        else if (symbol.includes('fog')) wmoCode = 45;
        else if (symbol.includes('thunder')) wmoCode = 95;
        else if (symbol.includes('snow') || symbol.includes('sleet')) wmoCode = 71;
        else if (symbol.includes('heavyrain')) wmoCode = 65;
        else if (symbol.includes('rain') || symbol.includes('drizzle')) wmoCode = 61;

        const info = getWeatherInfo(wmoCode);
        const rainProb = totalPrecip > 5 ? 80 : totalPrecip > 1 ? 50 : totalPrecip > 0 ? 30 : 10;

        return {
            tempMax: Math.round(Math.max(...temps)),
            tempMin: Math.round(Math.min(...temps)),
            rainProb,
            desc: info.label,
            icon: info.icon,
            isHistoricalEstimate: false
        };
    } catch (err) {
        logger.warn('Failed to fetch MET Norway fallback forecast:', err);
        return null;
    }
}

/**
 * 查詢特定經緯度與日期區間的天氣
 * @param {number} lat
 * @param {number} lng
 * @param {string} targetDate - YYYY-MM-DD
 * @returns {Promise<{tempMax: number, tempMin: number, rainProb: number, desc: string, icon: string, isHistoricalEstimate: boolean}|null>}
 */
export async function getDayWeather(lat, lng, targetDate) {
    if (!lat || !lng || !targetDate) return null;

    const today = new Date().toISOString().slice(0, 10);
    const target = new Date(targetDate);
    const now = new Date(today);
    const diffDays = Math.round((target - now) / 86400000);

    // 1. 若在未來 16 天之內且不是過去日期，走 Open-Meteo 16-day forecast (含逾時控制與備援)
    if (diffDays >= 0 && diffDays <= 15) {
        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
            const res = await fetchWithTimeout(url, {}, 4500);
            if (res.ok) {
                const data = await res.json();
                const dates = data.daily?.time || [];
                const idx = dates.indexOf(targetDate);
                if (idx !== -1) {
                    const code = data.daily.weather_code[idx];
                    const info = getWeatherInfo(code);
                    return {
                        tempMax: Math.round(data.daily.temperature_2m_max[idx]),
                        tempMin: Math.round(data.daily.temperature_2m_min[idx]),
                        rainProb: data.daily.precipitation_probability_max?.[idx] || 0,
                        desc: info.label,
                        icon: info.icon,
                        isHistoricalEstimate: false
                    };
                }
            }
        } catch (err) {
            logger.warn('Failed to fetch Open-Meteo forecast:', err);
        }

        // Open-Meteo 即時預報逾時或失敗時，優先切換至 MET Norway 即時預報備援
        const fallbackForecast = await fetchMetNoForecastFallback(lat, lng, targetDate);
        if (fallbackForecast) {
            return fallbackForecast;
        }
    }

    // 2. 超出 16 天範圍或過去日期，調用前一年同日期的歷史氣候紀錄 (Historical Archive)
    try {
        const pastYear = target.getFullYear() - 1;
        const pastDateStr = `${pastYear}-${targetDate.slice(5)}`;
        const archiveUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&start_date=${pastDateStr}&end_date=${pastDateStr}&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto`;

        const res = await fetchWithTimeout(archiveUrl, {}, 5000);
        if (!res.ok) return null;
        const data = await res.json();

        if (data.daily?.temperature_2m_max?.length > 0) {
            const code = data.daily.weather_code[0];
            const info = getWeatherInfo(code);
            return {
                tempMax: Math.round(data.daily.temperature_2m_max[0]),
                tempMin: Math.round(data.daily.temperature_2m_min[0]),
                rainProb: 20, // 歷史預設
                desc: `${info.label} (歷年氣候預估)`,
                icon: info.icon,
                isHistoricalEstimate: true
            };
        }
    } catch (err) {
        logger.warn('Failed to fetch historical weather archive:', err);
    }

    return null;
}
