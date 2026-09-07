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

// ---- push alerts -----------------------------------------------------------
//
// The push-alerts edge function sends one of these when a rest ends, or when a
// check-in is due, and the app is closed or suspended. The payload is JSON the
// function wrote; it is still treated as DATA -- every field is checked before
// it is shown, because a service worker rendering unchecked strings onto a lock
// screen is the same class of mistake as innerHTML.

interface AlertPayload {
  kind?: unknown;
  title?: unknown;
  body?: unknown;
  url?: unknown;
  badge?: unknown;
  alert_id?: unknown;
  fire_at?: unknown;
}

/**
 * Defaults per kind, used when the server said nothing readable.
 *
 * A push under `userVisibleOnly` MUST show a notification, so there is no
 * branch here that shows nothing: an unreadable payload still means something
 * happened, and saying so vaguely beats a silent push (which browsers punish
 * by revoking the subscription).
 */
const ALERT_KINDS = {
  rest: { title: "Rest over", body: "Next set." },
  daily_readiness: { title: "Morning check-in", body: "How are you today?" },
  ostrc_weekly: { title: "Weekly check", body: "Anything bothering you?" },
  next_morning_pain: {
    title: "How does it feel this morning?",
    body: "The morning after is the one that counts.",
  },
} as const;

type AlertKind = keyof typeof ALERT_KINDS;

function readKind(v: unknown): AlertKind {
  return typeof v === "string" && v in ALERT_KINDS ? (v as AlertKind) : "rest";
}

self.addEventListener("push", (event) => {
  let data: AlertPayload = {};
  try {
    const parsed: unknown = event.data?.json();
    if (parsed && typeof parsed === "object") data = parsed as AlertPayload;
  } catch {
    // Not JSON. Still a real event; the defaults below say so.
  }
  const kind = readKind(data.kind);
  const fallback = ALERT_KINDS[kind];
  const title =
    typeof data.title === "string" && data.title.length > 0
      ? data.title
      : fallback.title;
  const body = typeof data.body === "string" ? data.body : fallback.body;

  // `tag` collapses a backlog into one notification and `renotify` makes a
  // replacement buzz again -- one rest, one alert, even if a phone was offline
  // and two arrive together. TAGGED BY KIND, because the same mechanism that
  // usefully collapses two rest alerts would otherwise let a check-in prompt
  // silently REPLACE a rest alert on the lock screen. The browser requires a
  // notification for a push received under userVisibleOnly, so this is not
  // conditional on whether the app is open: the tone plays too when it is, and
  // two cues beats none.
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        tag: kind,
        renotify: true,
        data,
      } as NotificationOptions);

      // The app icon badge. iOS 16.4+ honours this for a home-screen web app,
      // and only while notification permission is granted -- which it is, or
      // this handler would not be running. Feature-detected because the API is
      // absent on older iOS and on some desktop browsers, and a missing badge
      // must never cost the notification that came with it.
      //
      // The count comes from the server, which is the only side that can know
      // how many things are actually waiting. Defaults to 1: one notification
      // just arrived, so the badge is at least that. Wrapped because a badge is
      // decoration and the notification is the message.
      const badge =
        typeof data.badge === "number" && Number.isFinite(data.badge)
          ? Math.max(0, Math.min(99, Math.round(data.badge)))
          : 1;
      try {
        if ("setAppBadge" in self.navigator) {
          await (
            self.navigator as WorkerNavigator & {
              setAppBadge(n?: number): Promise<void>;
            }
          ).setAppBadge(badge);
        }
      } catch {
        // Never let the badge break the alert.
      }
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      // Acting on it is reading it. Clearing here as well as on foreground
      // covers the case where the app was already open behind the lock screen
      // and never fires a visibility change.
      try {
        if ("clearAppBadge" in self.navigator) {
          await (
            self.navigator as WorkerNavigator & {
              clearAppBadge(): Promise<void>;
            }
          ).clearAppBadge();
        }
      } catch {
        // Decoration, again.
      }
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
