// @vitest-environment jsdom
//
// CORE-1 / NEW-CORE-1 against the REAL supabase-js client (auth-js), because
// the bug lives in what auth-js does, not in what a mock says it does: with an
// expired stored session and no network, auth-js retries the refresh for about
// 25 s and then emits INITIAL_SESSION(null) to listeners even though nobody
// signed out. Fetch always rejects here; time is faked so 25 s costs nothing.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

/** Node 26 defines its own `localStorage` global that shadows jsdom's and is
 *  unusable without --localstorage-file; an in-memory one works on every Node. */
function stubMemoryStorage(): void {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  });
}

const OWNER = "strengthLogCacheOwner";

function storageKey(): string {
  const url: string =
    import.meta.env.VITE_SUPABASE_URL ?? "https://placeholder.supabase.co";
  return `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
}

beforeEach(() => {
  // setImmediate stays real for fake-indexeddb
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  vi.resetModules();
  // auth-js logs every failed refresh attempt
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  stubMemoryStorage();
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  Object.defineProperty(navigator, "onLine", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
}

describe("CORE-1 / NEW-CORE-1: real auth-js, expired token, no network", () => {
  it("shows the stored session promptly, keeps the cache, and never claims null", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        access_token: "a",
        refresh_token: "r",
        expires_at: past,
        expires_in: 3600,
        token_type: "bearer",
        user: {
          id: "user-A",
          aud: "authenticated",
          app_metadata: {},
          user_metadata: {},
          created_at: "x",
        },
      }),
    );
    localStorage.setItem(OWNER, "user-A");

    const db = await import("../lib/db");
    db.resetDbForTests();
    await db.cacheSet("plan", { x: 1 });
    const cu = await import("../lib/currentUser"); // boots on import
    const claim = vi.spyOn(db, "claimCacheFor");
    const { useAuth } = await import("./useAuth");

    const { result } = renderHook(() => useAuth());
    // Well inside auth-js's ~25 s of refresh retries: the shell is up.
    await act(async () => {
      await advance(1000);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.session?.user.id).toBe("user-A");
    expect(cu.getCurrentUserId()).toBe("user-A");

    // Now let auth-js finish failing and emit its INITIAL_SESSION(null).
    await act(async () => {
      await advance(40_000);
    });
    expect(result.current.session?.user.id).toBe("user-A");
    expect(cu.getCurrentUserId()).toBe("user-A");
    expect(claim).not.toHaveBeenCalledWith(null);
    expect(await db.cacheGet("plan")).toEqual({ x: 1 });
    expect(localStorage.getItem(OWNER)).toBe("user-A");
    expect(localStorage.getItem(storageKey())).not.toBeNull();
  }, 30_000);
});
