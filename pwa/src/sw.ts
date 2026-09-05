/// <reference lib="webworker" />
// The service worker, written by hand.
//
// Until 6f this file did not exist: vite-plugin-pwa GENERATED the worker
// (`generateSW`) from the config in vite.config.ts. A push handler cannot be
// expressed in that config, so the worker is now source (`injectManifest`), and
// the first job of this file is to be EXACTLY the worker generateSW produced —
// same precache, same navigation fallback, same update semantics — with the
// two push listeners added at the bottom. The built `dist/sw.js` was diffed
// against the generated one when this landed: 11 precache entries before, 11
// after.
//
// WHAT THE GENERATED WORKER DID, reproduced in order:
//
//   1. `skipWaiting` ONLY on the SKIP_WAITING message. registerType is
//      "prompt" (see CLAUDE.md on updates): a new build installs and WAITS, and
//      main.tsx decides when to send this message — never mid-set. An
//      unconditional skipWaiting here, or `clientsClaim()`, would reintroduce
//      the reload-under-a-lifter that "prompt" exists to prevent. generateSW
//      emitted neither, so neither is here.
//   2. Precache the app shell from the manifest the build injects.
//   3. Drop caches left by older Workbox versions.
//   4. Serve index.html for navigations, so a cold offline launch of any
//      route paints the app.
//
// WHAT IT DID NOT DO, and this file does not either: runtime caching. No
// fetch handler touches a cross-origin request. Supabase responses are never
// in the Cache API — the app keeps its own IndexedDB cache — and exercise
// photos are deliberately fetched live.

import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & {
  /** injected by vite-plugin-pwa at build time */
  __WB_MANIFEST: Array<PrecacheEntry | string>;
};

// 1. The update handshake. workbox-window's messageSkipWaiting() sends
//    exactly this shape; main.tsx triggers it through registerSW's updateSW.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

// 2 + 3. The app shell.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// 4. Navigations fall back to the shell. Relative to the worker's scope, so
//    subpath hosting (PAGES_BASE) works unchanged.
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html")));

// ---- rest alerts (6f) ------------------------------------------------------
//
// The push-alerts edge function sends one of these when a rest ends and the
// app is closed or suspended. The payload is JSON the function wrote; it is
// still treated as data — every field is checked before it is shown.

interface RestAlertPayload {
  title?: unknown;
  body?: unknown;
  alert_id?: unknown;
  fire_at?: unknown;
}

self.addEventListener("push", (event) => {
  let data: RestAlertPayload = {};
  try {
    const parsed: unknown = event.data?.json();
    if (parsed && typeof parsed === "object") data = parsed as RestAlertPayload;
  } catch {
    // Not JSON. A push with no readable body is still a rest that ended;
    // the defaults below say so.
  }
  const title =
    typeof data.title === "string" && data.title.length > 0
      ? data.title
      : "Rest over";
  const body = typeof data.body === "string" ? data.body : "Next set.";
  // `tag` collapses a backlog into one notification and `renotify` makes a
  // replacement buzz again — one rest, one alert, even if a phone was offline
  // and two arrive together. The browser REQUIRES a notification to be shown
  // for a push received under userVisibleOnly, so this is not conditional on
  // whether the app is open: the tone plays too when it is, and two cues
  // beats none.
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: "rest",
      renotify: true,
      data,
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      // Bring back the app if it is open anywhere; otherwise open it at the
      // scope root, which is Today. The session, if one is running, is one tap
      // away there and its rest strip already shows the right number.
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const target =
        clients.find((c) => c.visibilityState === "visible") ?? clients[0];
      if (target) {
        await target.focus();
        return;
      }
      await self.clients.openWindow(self.registration.scope);
    })(),
  );
});
