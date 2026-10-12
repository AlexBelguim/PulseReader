import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  // `npm run dev` + `npm run server`: the app talks to its own origin, so
  // forward the server's routes to it, same as when the server hosts the build.
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'favicon-32.png', 'favicon-16.png', 'apple-touch-icon.png', 'masked-icon.svg'],
      manifest: {
        name: 'PulseReader',
        short_name: 'Pulse',
        description: 'Speed reading ePub application',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            // A maskable icon needs its own file: Android crops to a circle or
            // squircle, and the standard icon's mark runs too close to the
            // edge to survive that. This one is full-bleed with the reticle
            // held inside the centre 80% safe zone.
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // The fonts (public/fonts) are precached with the app, so the reader
        // has them offline from the first open.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      }
    })
  ],
})
