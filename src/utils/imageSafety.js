/**
 * imageSafety.js
 * Strict image URL sanitization (blocks javascript:/data:text/html XSS) and Canvas photo compression for IndexedDB/Drive lean storage.
 */

const SAFE_DATA_IMAGE_RE = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/i;

/**
 * Validate an image URL or base64 data URI.
 * Only permits https:// URLs or safe raster data URIs (jpeg/png/webp).
 * @param {string} rawUrl
 * @returns {string} sanitized URL or empty string if unsafe
 */
export function sanitizeImageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (!trimmed) return '';

    if (SAFE_DATA_IMAGE_RE.test(trimmed)) {
        return trimmed;
    }

    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === 'https:') {
            return parsed.toString();
        }
    } catch {
        return '';
    }
    return '';
}

/**
 * Compress a local image File via HTML5 Canvas to <= 480px JPEG (<60KB) for lean IndexedDB/Drive storage.
 * @param {File} file
 * @param {number} [maxWidth=480]
 * @param {number} [quality=0.75]
 * @returns {Promise<string>} safe data:image/jpeg;base64,... URI
 */
export async function compressPlacePhoto(file, maxWidth = 480, quality = 0.75) {
    if (!file) throw new Error('未選擇圖片檔案');
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('讀取圖片失敗'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('不支援的圖片格式'));
            img.onload = () => {
                const scale = img.width > maxWidth ? maxWidth / img.width : 1;
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                resolve(dataUrl);
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}
