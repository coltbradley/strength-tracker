// The client half of closed-app rest alerts. The push service and the server
// are not under test; what is under test is that this module never gets in the
// way of logging a set — no network when it cannot help, null on every
// failure, one toast for the one answer worth repeating to the person — and
// that what it does send is what the function expects.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { access_token: "test-jwt" } } }),
    },
  },
}));
vi.mock("./errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));

import { reportError, toast } from "./errors";
import {
  cancelRestAlert,
  pushState,
  pushSupported,
  scheduleRestAlert,
  subscribeToRestAlerts,
  unsubscribeFromRestAlerts,
  urlBase64ToUint8Array,
} from "./push";

interface FakeSub {
  endpoint: string;
  unsubscribed: boolean;
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: () => Promise<boolean>;
}

function fakeSub(endpoint = "https://push.example.test/abc"): FakeSub {
  const s: FakeSub = {
    endpoint,
    unsubscribed: false,
    toJSON: () => ({ endpoint, keys: { p256dh: "B" + "A".repeat(86), auth: "A".repeat(22) } }),
    unsubscribe: () => {
      s.unsubscribed = true;
      return Promise.resolve(true);
    },
  };
  return s;
}

let sub: FakeSub | null;
let subscribeCalls: { applicationServerKey?: unknown; userVisibleOnly?: boolean }[];
const reg = {
  pushManager: {
    getSubscription: () => Promise.resolve(sub),
    subscribe: (o: { applicationServerKey?: unknown; userVisibleOnly?: boolean }) => {
      subscribeCalls.push(o);
      sub = fakeSub();
      return Promise.resolve(sub);
    },
  },
};

function installBrowser(
  opts: { permission?: string; online?: boolean; push?: boolean } = {},
) {
  vi.stubGlobal("navigator", {
    onLine: opts.online ?? true,
    serviceWorker: { getRegistration: () => Promise.resolve(reg) },
  });
  if (opts.push !== false) vi.stubGlobal("PushManager", class {});
  const permission = opts.permission ?? "granted";
  vi.stubGlobal("Notification", {
    permission,
    requestPermission: () => Promise.resolve(permission),
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Route the fetch mock by the last path segment. */
function server(routes: Record<string, (body: unknown) => Response>) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    const route = url.slice(url.lastIndexOf("/") + 1);
    const handler = routes[route];
    if (!handler) throw new Error(`unexpected route ${route}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return handler(body);
  });
}

function calls(): { route: string; init: RequestInit | undefined }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = String(input);
    return { route: url.slice(url.lastIndexOf("/") + 1), init };
  });
}

beforeEach(() => {
  sub = null;
  subscribeCalls = [];
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
  vi.mocked(toast).mockClear();
  vi.mocked(reportError).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pushSupported / pushState", () => {
  it("is unsupported without a PushManager (a Safari tab on iOS)", async () => {
    installBrowser({ push: false });
    expect(pushSupported()).toBe(false);
    expect(await pushState()).toBe("unsupported");
  });

  it("reports the four honest states", async () => {
    installBrowser({ permission: "denied" });
    expect(await pushState()).toBe("denied");
    installBrowser();
    expect(await pushState()).toBe("off");
    sub = fakeSub();
    expect(await pushState()).toBe("on");
  });
});

describe("scheduleRestAlert", () => {
  it("does nothing when this device is not subscribed", async () => {
    installBrowser();
    expect(await scheduleRestAlert(Date.now() + 60_000, "Row set 2")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing offline, even when subscribed", async () => {
    installBrowser({ online: false });
    sub = fakeSub();
    expect(await scheduleRestAlert(Date.now() + 60_000, "Row set 2")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing once aborted", async () => {
    installBrowser();
    sub = fakeSub();
    const c = new AbortController();
    c.abort();
    expect(await scheduleRestAlert(Date.now() + 60_000, "Row set 2", c.signal)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the deadline and label with the session bearer, and returns the id", async () => {
    installBrowser();
    sub = fakeSub();
    server({ schedule: () => jsonResponse({ alert_id: "a-1" }, 202) });
    const fireAt = Date.UTC(2026, 8, 5, 18, 0, 30);
    expect(await scheduleRestAlert(fireAt, "Barbell Row set 3")).toBe("a-1");
    const [c] = calls();
    expect(c.route).toBe("schedule");
    expect(c.init?.method).toBe("POST");
    expect((c.init?.headers as Record<string, string>).authorization).toBe("Bearer test-jwt");
    expect(JSON.parse(String(c.init?.body))).toEqual({
      fire_at: "2026-09-05T18:00:30.000Z",
      label: "Barbell Row set 3",
    });
    expect(toast).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("treats a 422 as an answer: null, told once, never reported as an error", async () => {
    installBrowser();
    sub = fakeSub();
    server({
      schedule: () => jsonResponse({ error: "This server can only hold an alert for about 120 s right now." }, 422),
    });
    expect(await scheduleRestAlert(Date.now() + 180_000, "Squat set 1")).toBeNull();
    expect(await scheduleRestAlert(Date.now() + 180_000, "Squat set 2")).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(toast).mock.calls[0][0])).toContain("120 s");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("re-files the device's subscription under the current user on a 409 and retries once", async () => {
    installBrowser();
    sub = fakeSub();
    let schedules = 0;
    server({
      schedule: () =>
        ++schedules === 1
          ? jsonResponse({ error: "No push subscription for this account." }, 409)
          : jsonResponse({ alert_id: "a-2" }, 202),
      subscribe: (body) => {
        expect(body).toEqual(sub!.toJSON());
        return jsonResponse({ ok: true }, 200);
      },
    });
    expect(await scheduleRestAlert(Date.now() + 60_000, "Row set 2")).toBe("a-2");
    expect(calls().map((c) => c.route)).toEqual(["schedule", "subscribe", "schedule"]);
  });

  it("reports any other failure silently and returns null", async () => {
    installBrowser();
    sub = fakeSub();
    server({ schedule: () => jsonResponse({ error: "boom" }, 500) });
    expect(await scheduleRestAlert(Date.now() + 60_000, "Row set 2")).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalled();
  });

  it("survives a network failure without throwing", async () => {
    installBrowser();
    sub = fakeSub();
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await scheduleRestAlert(Date.now() + 60_000, "Row set 2")).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("cancelRestAlert", () => {
  it("posts the alert id, and swallows nothing silently but a network answer of no", async () => {
    installBrowser();
    server({ cancel: () => jsonResponse({ ok: true, cancelled: true }, 200) });
    await cancelRestAlert("a-1");
    const [c] = calls();
    expect(c.route).toBe("cancel");
    expect(JSON.parse(String(c.init?.body))).toEqual({ alert_id: "a-1" });
    expect(reportError).not.toHaveBeenCalled();

    server({ cancel: () => jsonResponse({ error: "nope" }, 500) });
    await cancelRestAlert("a-1");
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("does nothing offline", async () => {
    installBrowser({ online: false });
    await cancelRestAlert("a-1");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("subscribeToRestAlerts", () => {
  it("stops at a refused permission without touching the network", async () => {
    installBrowser({ permission: "denied" });
    expect(await subscribeToRestAlerts()).toBe("denied");
    expect(fetch).not.toHaveBeenCalled();
    expect(subscribeCalls).toHaveLength(0);
  });

  it("fetches the server key, subscribes with it, and files the subscription", async () => {
    installBrowser();
    const publicKey = "B" + "A".repeat(86);
    server({
      "vapid-public-key": () => jsonResponse({ public_key: publicKey }, 200),
      subscribe: (body) => {
        expect(body).toEqual(fakeSub().toJSON());
        return jsonResponse({ ok: true }, 200);
      },
    });
    expect(await subscribeToRestAlerts()).toBe("on");
    expect(subscribeCalls).toHaveLength(1);
    expect(subscribeCalls[0].userVisibleOnly).toBe(true);
    const key = subscribeCalls[0].applicationServerKey as Uint8Array;
    expect(key.length).toBe(65);
    expect(key[0]).toBe(4);
    expect(calls().map((c) => c.route)).toEqual(["vapid-public-key", "subscribe"]);
  });

  it("undoes the browser subscription when the server never heard of it", async () => {
    installBrowser();
    server({
      "vapid-public-key": () => jsonResponse({ public_key: "B" + "A".repeat(86) }, 200),
      subscribe: () => jsonResponse({ error: "down" }, 500),
    });
    expect(await subscribeToRestAlerts()).toBe("off");
    expect(sub?.unsubscribed).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});

describe("unsubscribeFromRestAlerts", () => {
  it("tells the server, then drops the browser subscription", async () => {
    installBrowser();
    const s = fakeSub();
    sub = s;
    server({
      unsubscribe: (body) => {
        expect(body).toEqual({ endpoint: s.endpoint });
        // the browser side is dropped afterwards, so the state reads off
        sub = null;
        return jsonResponse({ ok: true }, 200);
      },
    });
    expect(await unsubscribeFromRestAlerts()).toBe("off");
    expect(s.unsubscribed).toBe(true);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes the unpadded alphabet Web Push uses", () => {
    expect(Array.from(urlBase64ToUint8Array("AAEC_-8"))).toEqual([0, 1, 2, 255, 239]);
  });
});
