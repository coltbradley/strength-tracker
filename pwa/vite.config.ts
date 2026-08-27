import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Service worker precaches the app shell only. Supabase REST responses are
// deliberately NOT cached by the SW — the app does its own IndexedDB caching
// and we never want authed API responses in the Cache API.
// Subpath hosting (e.g. GitHub Pages at /strength-tracker/): build with
// PAGES_BASE=/strength-tracker/ — base, router basename (via BASE_URL), and
// the manifest all follow.
const base = process.env.PAGES_BASE || "/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png"],
      manifest: {
        name: "Strength Log",
        short_name: "Strength",
        description: "Offline-first strength training log",
        display: "standalone",
        start_url: base,
        scope: base,
        // keep in sync with --paper in src/styles.css and the theme-color
        // meta in index.html
        background_color: "#f4eede",
        theme_color: "#f4eede",
        icons: [
          {
            src: "icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // woff2 covers the self-hosted Chivo faces in public/fonts, so a cold
        // offline launch still paints in the real typeface.
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "index.html",
        // Never let the SW intercept cross-origin (Supabase) requests.
        runtimeCaching: [],
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
