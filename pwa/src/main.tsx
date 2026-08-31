import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { cacheGet, cacheKeys } from "./lib/db";
import { installGlobalHandlers, initSentry } from "./lib/errors";
import { outbox } from "./lib/sync";
import "./styles.css";

installGlobalHandlers();
void initSentry();
outbox.start(); // flush on app start + 'online' events

// Ask the browser not to evict us.
//
// The outbox holds sets that exist NOWHERE else until they sync, and WebKit's
// storage policy clears IndexedDB, localStorage and the service worker
// registration alike after about a week without interaction. A lifter who logs
// offline, goes on holiday and comes back would find the session gone — and
// `sets` being append-only, gone is permanent.
//
// Best-effort by design: browsers grant this on their own criteria (an
// installed home-screen app is usually granted outright, which is the case
// that matters most here), it is absent entirely on older Safari, and it must
// never be awaited on the startup path. A rejection is not an error worth
// reporting to the user — there is nothing they could do about it.
void navigator.storage?.persist?.().catch(() => undefined);

// Let a new build in as soon as it costs the user nothing — and make sure it
// is actually noticed.
//
// The worker is registered "prompt", so an update installs and then WAITS.
// Applying it reloads the page, and the one moment that must never happen is
// mid-set: staged reps and load, and any half-typed set note, would go with
// it. Logged sets are already safe — they hit the IndexedDB outbox on the tap
// — but the rest of the screen is not.
//
// The first version of this deferred every update to the next
// visibilitychange→hidden, and that was too clever by half. An installed PWA
// on a phone can go a long time without a clean background-then-return, the
// browser only checks for a new worker when the page is registered, and there
// was no periodic check at all — so a shipped build could sit waiting,
// unnoticed, while the person using it wondered where the feature went. That
// happened on the first real deploy. Trading "never interrupts a set" for
// "might never arrive" is a bad trade; this keeps the first and drops the
// second.
//
// Two halves. NOTICE: ask the browser to look for a new worker whenever the
// app comes back to the foreground, and hourly while it is open. APPLY: if
// there is no session in progress, take it immediately — reloading Today or
// History costs nothing. Only mid-session does it wait, and then only until
// the app is next hidden.
async function sessionInProgress(): Promise<boolean> {
  try {
    return (await cacheGet(cacheKeys.activeSession)) != null;
  } catch {
    // If we cannot tell, assume we are mid-session: a delayed update is a
    // nuisance, an interrupted set is lost work.
    return true;
  }
}

const applyUpdate = registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => void registration.update().catch(() => undefined);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
    window.setInterval(check, 60 * 60 * 1000);
  },
  onNeedRefresh() {
    void (async () => {
      if (!(await sessionInProgress())) {
        void applyUpdate(true);
        return;
      }
      const onHidden = () => {
        if (document.visibilityState !== "hidden") return;
        document.removeEventListener("visibilitychange", onHidden);
        void applyUpdate(true);
      };
      document.addEventListener("visibilitychange", onHidden);
      // already backgrounded when the update landed
      onHidden();
    })();
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
