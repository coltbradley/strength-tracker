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
      // NOT "autoUpdate". That combination — autoUpdate plus
      // registerSW({immediate:true}) — makes a new deploy call skipWaiting and
      // reload the open page the moment it is noticed. Mid-set, that throws
      // away whatever is staged in the steppers and any half-typed set note,
      // and it does it at the one moment the user is least able to deal with
      // it. "prompt" leaves the new worker WAITING instead, and main.tsx
      // decides when to let it in. Same runtime rule as the additive-only
      // IndexedDB versioning: an update must never cost the user work.
      registerType: "prompt",
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
        // ...except the two -latin-ext faces (34.7 kB, 12.6% of first load).
        // Their @font-face unicode-range starts at U+0100; the -latin files
        // cover U+0000-00FF, which is every glyph this app renders: English
        // UI text, exercise names from free-exercise-db (ASCII), numbers.
        // They are still BUILT and SERVED, just fetched on demand rather than
        // downloaded by every install.
        //
        // Accepted tradeoff: a lifter who is fully offline AND has typed a
        // Central-European glyph (a coach note, a custom exercise name) sees
        // the system fallback face for those glyphs only. The surrounding
        // text stays Chivo, because the browser resolves @font-face per
        // character range. Online, the glyph triggers a normal font fetch.
        globIgnores: ["**/*-latin-ext.woff2"],
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
