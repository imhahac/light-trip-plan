/**
 * byokVisionService.js
 * Bring-Your-Own-Key (BYOK) Client-Side AI Receipt & Booking Scanner.
 * - Supports Gemini API & OpenAI-compatible Vision endpoints (both browser CORS-friendly).
 * - API Key is stored ONLY in sessionStorage (cleared when tab closes; never sent to our Worker).
 * - Compresses images via HTML5 Canvas (maxWidth 1280px, JPEG 0.8) to avoid payload bloat.
 */

const SESSION_KEY_PROVIDER = 'ltp_byok_ai_provider';
const SESSION_KEY_API_KEY = 'ltp_byok_ai_key';
const SESSION_KEY_BASE_URL = 'ltp_byok_ai_base_url';
const TIMEOUT_MS = 20000;

export function getByokAiConfig() {
    try {
        if (typeof window === 'undefined' || !window.sessionStorage) {
            return { provider: 'gemini', apiKey: '', baseUrl: '' };
        }
        return {
            provider: window.sessionStorage.getItem(SESSION_KEY_PROVIDER) || 'gemini',
            apiKey: window.sessionStorage.getItem(SESSION_KEY_API_KEY) || '',
            baseUrl: window.sessionStorage.getItem(SESSION_KEY_BASE_URL) || '',
        };
    } catch {
        return { provider: 'gemini', apiKey: '', baseUrl: '' };
    }
}

export function saveByokAiConfig({ provider = 'gemini', apiKey = '', baseUrl = '' }) {
    try {
        if (typeof window === 'undefined' || !window.sessionStorage) return;
        window.sessionStorage.setItem(SESSION_KEY_PROVIDER, provider);
        if (apiKey) {
            window.sessionStorage.setItem(SESSION_KEY_API_KEY, apiKey.trim());
        } else {
            window.sessionStorage.removeItem(SESSION_KEY_API_KEY);
        }
        if (baseUrl) {
            window.sessionStorage.setItem(SESSION_KEY_BASE_URL, baseUrl.trim());
        } else {
            window.sessionStorage.removeItem(SESSION_KEY_BASE_URL);
        }
    } catch {
        // ignore storage errors
    }
}

/**
 * Compress an image File/Blob via HTML5 Canvas to <= 1280px JPEG and return base64 string (without data URL prefix).
 */
export async function compressImageToBase64(file, maxWidth = 1280, quality = 0.8) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('讀取圖片失敗'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('圖片格式不支援'));
            img.onload = () => {
                const scale = img.width > maxWidth ? maxWidth / img.width : 1;
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                const base64 = dataUrl.split(',')[1] || '';
                resolve({ base64, mimeType: 'image/jpeg' });
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

export function extractJsonFromAiText(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

const RECEIPT_PROMPT = `Extract receipt expense fields and return ONLY valid JSON with these exact keys:
{"title":"merchant or short description","amount":123.45,"currency":"TWD|JPY|USD|EUR|KRW|THB|GBP","date":"YYYY-MM-DD","category":"food|transport|lodging|shopping|ticket|other","notes":"optional short item summary"}
If a field is unknown, use null.`;

/**
 * Scan a receipt image using the user's BYOK Gemini or OpenAI-compatible API key.
 * @param {File} imageFile
 * @param {{ provider?: 'gemini' | 'openai', apiKey: string, baseUrl?: string }} config
 */
export async function scanReceiptWithByokAI(imageFile, config) {
    if (!config?.apiKey) {
        throw new Error('請先輸入您的 AI API Key（僅存於本次分頁 sessionStorage）');
    }
    const { base64, mimeType } = await compressImageToBase64(imageFile);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        let rawText = '';
        if ((config.provider || 'gemini') === 'gemini') {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(config.apiKey)}`;
            const res = await fetch(url, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: RECEIPT_PROMPT },
                            { inline_data: { mime_type: mimeType, data: base64 } },
                        ],
                    }],
                }),
            });
            if (!res.ok) throw new Error(`Gemini API 錯誤 (${res.status})`);
            const data = await res.json();
            rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else {
            const base = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
            const res = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini',
                    messages: [{
                        role: 'user',
                        content: [
                            { type: 'text', text: RECEIPT_PROMPT },
                            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
                        ],
                    }],
                    max_tokens: 300,
                }),
            });
            if (!res.ok) throw new Error(`OpenAI API 錯誤 (${res.status})`);
            const data = await res.json();
            rawText = data?.choices?.[0]?.message?.content || '';
        }

        const parsed = extractJsonFromAiText(rawText);
        if (!parsed) throw new Error('AI 未回傳可解析的 JSON 格式');

        return {
            title: parsed.title || '收據消費',
            amount: Number.isFinite(Number(parsed.amount)) ? Number(parsed.amount) : 0,
            currency: parsed.currency || 'TWD',
            date: parsed.date || new Date().toISOString().slice(0, 10),
            category: parsed.category || 'food',
            notes: parsed.notes || '',
        };
    } finally {
        clearTimeout(timer);
    }
}
