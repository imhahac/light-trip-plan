import dns from 'node:dns'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// 避免 CI / Linux 環境下 IPv6 (AAAA) 連線黑洞導致外部 API (如 Open-Meteo) 10 秒逾時
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first')
}

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        react(),
        VitePWA({
            registerType: 'autoUpdate',
            injectRegister: 'auto',
            manifest: {
                name: 'Light Trip Plan',
                short_name: 'LightTrip',
                description: 'Light Trip Plan - 智能離線旅遊規劃中心',
                theme_color: '#4f46e5',
                background_color: '#ffffff',
                display: 'standalone',
                icons: [
                    // A placeholder icon requires to be placed in public folder manually later
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png'
                    }
                ]
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
                runtimeCaching: [
                    {
                        urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'google-fonts-cache',
                            expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
                            cacheableResponse: { statuses: [0, 200] }
                        }
                    },
                    {
                        // 僅被動快取支援 CORS (status 200) 的開放向量圖磚與 Terrarium 地形，嚴格避免 opaque (status 0) 7MB 空間膨脹
                        urlPattern: /^https:\/\/(tiles\.openfreemap\.org|s3\.amazonaws\.com\/elevation-tiles-prod)\/.*/i,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'ltp-map-tiles-cache',
                            expiration: { maxEntries: 250, maxAgeSeconds: 60 * 60 * 24 * 14 },
                            cacheableResponse: { statuses: [200] }
                        }
                    }
                ]
            }
        })
    ],
    // 對應 GitHub Repository 名稱
    base: '/light-trip-plan/',
    server: {
        host: true,
        port: 5173,
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
            'Cross-Origin-Embedder-Policy': 'unsafe-none',
        }
    },
    preview: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
            'Cross-Origin-Embedder-Policy': 'unsafe-none',
        }
    },
    build: {
        target: 'es2015',
        rollupOptions: {
            output: {
                manualChunks: {
                    'maplibre': ['maplibre-gl'],
                    'vendor': ['react', 'react-dom']
                }
            }
        }
    },
    test: {
        environment: 'jsdom',
        globals: true,
        exclude: process.env.RUN_LIVE_TESTS === 'true'
            ? ['**/node_modules/**', '**/dist/**']
            : [
                '**/node_modules/**',
                '**/dist/**',
                'src/services/__tests__/realServicesVerification.test.js',
            ],
    }
})