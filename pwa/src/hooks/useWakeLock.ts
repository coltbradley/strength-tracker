// Keep the screen awake while a session is open.
//
// A rest interval is two to four minutes of not touching the phone, which is
// longer than every default auto-lock setting on iOS. The rest strip counts
// down on a screen nobody can see, and the lifter finds out rest is over by
// picking the phone up with chalky hands and unlocking it. The Screen Wake
// Lock API is the standard answer, and it is supported by iOS Safari 16.4+ —
// including installed home-screen apps, which is where this app lives.
//
// THE PART EVERYONE GETS WRONG: the lock is released by the browser whenever
// the page stops being visible, and it does NOT come back on its own. Request
// it once at mount and it survives exactly until the first time the user
// switches apps — after which the screen sleeps again and the hook looks like
// it works because it worked for the first set. So the sentinel is dropped on
// `hidden` and re-requested on `visible`, every time.
//
// BEST-EFFORT, ALWAYS. Browsers without the API, a request rejected because
// the document was not visible or the battery is low, a lock the system takes
// back — all of them are silent. There is nothing the lifter could do about
// any of them mid-set, and the app is fully usable with the screen sleeping;
// that was the status quo. A wake lock is a convenience, so a failed one is
// never reported and never throws.

import { useEffect } from "react";

/** Only what we touch. Typed here rather than relying on the DOM lib to
 *  declare `navigator.wakeLock`, which varies by TS version. */
interface Sentinel {
  release: () => Promise<void>;
}

interface WakeLockApi {
  request: (type: "screen") => Promise<Sentinel>;
}

function wakeLockApi(): WakeLockApi | null {
  try {
    if (typeof navigator === "undefined") return null;
    const nav = navigator as unknown as { wakeLock?: Partial<WakeLockApi> };
    const wl = nav.wakeLock;
    if (!wl || typeof wl.request !== "function") return null;
    return wl as WakeLockApi;
  } catch {
    return null;
  }
}

/**
 * Hold a screen wake lock while `enabled`. The caller decides the window —
 * Session passes "a session is open", so the screen stays awake for a workout
 * and not for the rest of the app.
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const wl = wakeLockApi();
    if (wl === null) return;

    // `cancelled` guards the gap between asking and being answered: an unmount
    // during an in-flight request would otherwise leave a lock held by nobody,
    // and nothing would ever release it.
    let cancelled = false;
    let sentinel: Sentinel | null = null;

    const release = (s: Sentinel | null): void => {
      if (s === null) return;
      try {
        void Promise.resolve(s.release()).catch(() => undefined);
      } catch {
        // already gone
      }
    };

    const acquire = (): void => {
      if (cancelled || sentinel !== null) return;
      // A request made while hidden is rejected by spec. Skipping it keeps the
      // console clean and costs nothing: the visibilitychange below will ask
      // again the moment the page is back.
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      try {
        void Promise.resolve(wl.request("screen"))
          .then((s) => {
            if (cancelled) {
              release(s);
              return;
            }
            sentinel = s;
          })
          .catch(() => undefined);
      } catch {
        // a synchronous throw from a partial implementation
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        acquire();
        return;
      }
      // Hidden: the browser has released the lock whether or not it told us.
      // Dropping our reference is what makes the next `visible` re-request
      // instead of deciding it already holds one. Releasing the stale sentinel
      // too is belt and braces for implementations that hold on a little
      // longer than the spec requires.
      const stale = sentinel;
      sentinel = null;
      release(stale);
    };

    document.addEventListener("visibilitychange", onVisibility);
    acquire();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      const held = sentinel;
      sentinel = null;
      release(held);
    };
  }, [enabled]);
}
