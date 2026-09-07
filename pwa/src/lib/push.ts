// Rest alerts while the app is closed: the client half.
//
// The rest strip's tone needs a running page. When the app is closed or iOS
// has suspended it, the only thing that can announce the end of a rest is a
// Web Push delivered to the service worker, and the only thing that can SEND
// one at the right moment is a server: the push-alerts edge function. This
// module talks to it.
//
// EVERYTHING HERE IS BEST-EFFORT. A rest alert is a convenience layered on a
// log that must never wait for it: scheduling happens on the LOG tap and is
// never awaited there, a failure is reported to Sentry without a toast (the
// person is mid-set and can do nothing about it), and offline the module does
// nothing at all — a set logged in a basement gym is a set logged, alert or
// no alert. The one exception is the 422 the server sends when a rest is
// longer than it can hold: that is not an error but an answer, and the person
// is told once.
//
// The subscription is a fact about THIS DEVICE'S BROWSER, read from the push
// manager each time rather than mirrored into settings: a mirror can say ON
// after the browser has dropped the subscription, and a settings row that
// reports success for something that cannot happen is the one thing it must
// never do.

import { supabase } from "./supabase";
import { createTimeoutFetch } from "./timeoutFetch";
import { reportError, toast } from "./errors";

export type PushState = "unsupported" | "denied" | "off" | "on";

function endpoint(route: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL ?? "";
  return `${base}/functions/v1/push-alerts/${route}`;
}

/**
 * Whether this browser can receive pushes at all. False in a Safari TAB on
 * iOS — `PushManager` exists there only once the app is installed to the Home
 * Screen — which is the honest reason the Settings row says "needs the app
 * installed".
 */
export function pushSupported(): boolean {
  try {
    return (
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in globalThis &&
      typeof Notification !== "undefined"
    );
  } catch {
    return false;
  }
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  if (!reg) return null;
  try {
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** The four honest states the Settings row can show. */
export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await registration();
  if (!reg) return "unsupported";
  return (await currentSubscription()) ? "on" : "off";
}

// ---- transport --------------------------------------------------------------

/**
 * Report to Sentry WITHOUT the toast reportError raises. The LOG path must
 * not grow a toast for a convenience that failed; the tone still plays.
 */
function reportSilently(err: unknown, context: string): void {
  try {
    reportError(err, context);
  } catch {
    // reporting must never be the thing that breaks logging a set
  }
}

async function bearer(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** One call to the function. Null means "could not ask" (offline, signed
 *  out, no response); a Response means the server answered, whatever it said. */
async function call(
  route: string,
  init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal },
): Promise<Response | null> {
  const token = await bearer();
  if (!token) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  // Built per call so it wraps whatever `fetch` is NOW — the tests stub it
  // after this module has loaded, and so would any future instrumentation.
  return await createTimeoutFetch()(endpoint(route), {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
}

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // not JSON
  }
  return `push-alerts ${res.status}`;
}

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** base64url → bytes, for `applicationServerKey`. */
export function urlBase64ToUint8Array(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** What the server stores: the browser's own JSON for the subscription. */
function subscriptionBody(sub: PushSubscription): unknown {
  const json = sub.toJSON();
  return { endpoint: json.endpoint, keys: json.keys };
}

// ---- subscribe / unsubscribe (from a tap in Settings) -------------------------

/**
 * Turn closed-app alerts on for this device. Call from a user gesture: the
 * permission prompt is refused otherwise. Returns the state afterwards, which
 * the Settings row shows as-is; failures are reported with a toast because the
 * person is looking at the row that asked.
 */
export async function subscribeToRestAlerts(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch (e) {
    reportError(e, "rest alert permission");
    return Notification.permission === "denied" ? "denied" : "off";
  }
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const reg = await registration();
  if (!reg) return "unsupported";

  let sub: PushSubscription | null = null;
  try {
    const res = await call("vapid-public-key", { method: "GET" });
    if (!res) {
      toast("Can't reach the server to set up alerts — try again with signal.", "error");
      return "off";
    }
    if (!res.ok) throw new Error(await errorOf(res));
    const { public_key } = (await res.json()) as { public_key: string };
    sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(public_key) as BufferSource,
      }));
    const saved = await call("subscribe", {
      method: "POST",
      body: subscriptionBody(sub),
    });
    if (!saved) throw new Error("no response from the server");
    if (!saved.ok) throw new Error(await errorOf(saved));
    return "on";
  } catch (e) {
    reportError(e, "rest alert subscribe");
    // A browser subscription the server never heard of would show ON for an
    // alert that can never arrive. Undo it.
    if (sub) await sub.unsubscribe().catch(() => undefined);
    return "off";
  }
}

/** Turn closed-app alerts off for this device. Best-effort on the server
 *  side; the browser subscription is dropped regardless. */
export async function unsubscribeFromRestAlerts(): Promise<PushState> {
  const sub = await currentSubscription();
  if (!sub) return await pushState();
  try {
    const res = await call("unsubscribe", {
      method: "POST",
      body: { endpoint: sub.endpoint },
    });
    if (res && !res.ok) throw new Error(await errorOf(res));
  } catch (e) {
    // The server row stays live but no browser subscription backs it, so
    // nothing arrives; the function revokes it on the first 410.
    reportSilently(e, "rest alert unsubscribe");
  }
  try {
    await sub.unsubscribe();
  } catch (e) {
    reportError(e, "rest alert unsubscribe");
  }
  return await pushState();
}

// ---- schedule / cancel (from the session screen, never awaited on LOG) -----------

/** Said once per page load per distinct message: the server's "too long to
 *  hold" is the same answer every set, and one toast is information where ten
 *  are noise. */
const told = new Set<string>();

/**
 * Ask the server to push "Rest over — <label>" at `fireAt` (epoch ms).
 *
 * Resolves to the alert id, or null when nothing was scheduled: not
 * subscribed on this device, offline, refused, or aborted. Never throws. The
 * caller keeps the id to cancel it; a reload loses the id and the server fires
 * regardless, which is accepted (see Session.tsx).
 */
export async function scheduleRestAlert(
  fireAt: number,
  label: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!online()) return null;
  if (signal?.aborted) return null;
  const sub = await currentSubscription();
  if (!sub || signal?.aborted) return null;

  const body = { fire_at: new Date(fireAt).toISOString(), label };
  try {
    let res = await call("schedule", { method: "POST", body, signal });
    if (res?.status === 409) {
      // The browser is subscribed but the server has no row for THIS user —
      // someone else signed in on this phone since it subscribed. The endpoint
      // is the phone's, so re-file it under the current person and try again.
      const filed = await call("subscribe", {
        method: "POST",
        body: subscriptionBody(sub),
        signal,
      });
      if (filed?.ok) res = await call("schedule", { method: "POST", body, signal });
    }
    if (!res) return null;
    if (res.status === 202) {
      const { alert_id } = (await res.json()) as { alert_id?: unknown };
      return typeof alert_id === "string" ? alert_id : null;
    }
    if (res.status === 422) {
      // An answer, not a failure: the server cannot hold an alert this long.
      const why = await errorOf(res);
      if (!told.has(why)) {
        told.add(why);
        toast(`No closed-app alert for this rest: ${why}`);
      }
      return null;
    }
    reportSilently(new Error(await errorOf(res)), "rest alert schedule");
    return null;
  } catch (e) {
    if (signal?.aborted) return null;
    reportSilently(e, "rest alert schedule");
    return null;
  }
}

/** Stop an alert that was scheduled. Best-effort; never throws. */
export async function cancelRestAlert(alertId: string): Promise<void> {
  if (!online()) return;
  try {
    const res = await call("cancel", { method: "POST", body: { alert_id: alertId } });
    if (res && !res.ok) throw new Error(await errorOf(res));
  } catch (e) {
    reportSilently(e, "rest alert cancel");
  }
}


/**
 * Arm a long-dated prompt (the morning panel, the weekly OSTRC, the pain check
 * the morning after).
 *
 * Separate from `scheduleRestAlert` because the two have opposite needs. A rest
 * is minutes away and wants latency, so the function holds a worker open for
 * it. A prompt is hours or days away, which no worker survives -- so this only
 * WRITES the row, and delivery is a sweep somebody else runs.
 *
 * Which means this returns "armed", not "will arrive". If no sweep is wired,
 * these rows sit unsent and the app should fall back to asking in-app on
 * foreground, which is why `duePrompts` in ./prompts.ts is deliberately free of
 * any of this.
 */
export async function armPrompt(
  kind: "daily_readiness" | "ostrc_weekly" | "next_morning_pain",
  fireAt: Date,
  label?: string,
): Promise<{ armed: boolean; alertId?: string }> {
  if (!online()) return { armed: false };
  const sub = await currentSubscription();
  if (!sub) return { armed: false };
  try {
    const res = await call("arm", {
      method: "POST",
      body: {
        kind,
        fire_at: fireAt.toISOString(),
        ...(label ? { label } : {}),
      },
    });
    if (!res || res.status !== 202) return { armed: false };
    const { alert_id } = (await res.json()) as { alert_id?: unknown };
    return {
      armed: true,
      alertId: typeof alert_id === "string" ? alert_id : undefined,
    };
  } catch {
    // Offline, or push not configured. A prompt that could not be armed is not
    // an error worth showing anyone: the in-app path still asks.
    return { armed: false };
  }
}
