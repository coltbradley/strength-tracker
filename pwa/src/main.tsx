import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
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

// Let a new build in only when it costs the user nothing.
//
// The worker is registered "prompt", so an update installs and then WAITS.
// Applying it reloads the page, and the one moment that must never happen is
// mid-set: staged reps and load, and any half-typed set note, would go with
// it. Logged sets are already safe — they hit the IndexedDB outbox on the tap
// — but the rest of the screen is not.
//
// So: apply it the next time the app is hidden. Backgrounding the app is
// exactly when a reload is free, and a phone gets backgrounded constantly. If
// it never does, the waiting worker takes over on the next launch anyway,
// which is the default behaviour and also safe. There is no path here that
// strands someone on an old build, and none that interrupts them.
const applyUpdate = registerSW({
  immediate: true,
  onNeedRefresh() {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      document.removeEventListener("visibilitychange", onHidden);
      void applyUpdate(true);
    };
    document.addEventListener("visibilitychange", onHidden);
    // already in the background when the update landed
    onHidden();
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
