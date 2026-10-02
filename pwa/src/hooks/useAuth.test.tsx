// @vitest-environment jsdom
//
// The cold-start auth answer, against a mocked `supabase.auth`. The real
// client's behaviour is pinned in useAuth.supabase.test.tsx; here the events
// are scripted so each ordering can be stated exactly.

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { AuthRetryableFetchError, type Session } from "@supabase/supabase-js";

type Listener = (event: string, session: Session | null) => void;

const auth = vi.hoisted(() => ({
  // currentUser.ts boots on import (via errors -> sync) and calls this once
  getSession: vi.fn(() => new Promise(() => {})),
  listeners: [] as Array<(event: string, session: Session | null) => void>,
}));

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: () => auth.getSession(),
      onAuthStateChange: (fn: Listener) => {
        auth.listeners.push(fn);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                const i = auth.listeners.indexOf(fn);
                if (i >= 0) auth.listeners.splice(i, 1);
              },
            },
          },
        };
      },
    },
  },
  supabaseConfigured: true,
}));

import { useAuth } from "./useAuth";
import { cacheGet, cacheSet, getDb, resetDbForTests } from "../lib/db";
import * as dbModule from "../lib/db";

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

const KEY = "sb-test-auth-token";
const OWNER = "strengthLogCacheOwner";

function storedSession(userId = "user-A"): Session {
  return {
    access_token: "expired",
    refresh_token: "refresh",
    expires_at: Math.floor(Date.now() / 1000) - 3600,
    expires_in: 3600,
    token_type: "bearer",
    user: { id: userId },
  } as unknown as Session;
}

function seedStored(userId = "user-A") {
  localStorage.setItem(KEY, JSON.stringify(storedSession(userId)));
  localStorage.setItem(OWNER, userId);
}

const offlineError = () => new AuthRetryableFetchError("Failed to fetch", 0);

function emit(event: string, session: Session | null) {
  for (const fn of [...auth.listeners]) fn(event, session);
}

beforeEach(() => {
  // Only the timers under test: fake-indexeddb schedules on setImmediate.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  stubMemoryStorage();
  auth.listeners.length = 0;
  auth.getSession.mockReset();
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

/** Move the faked timers, then let fake-indexeddb's setImmediate turns run:
 *  the hook now renders only after the cache claim has finished. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
}

async function flush() {
  await act(async () => {
    await advance(0);
  });
}

describe("CORE-1: INITIAL_SESSION(null) after a failed refresh", () => {
  it("keeps the stored session and the cache; claimCacheFor is never called with null", async () => {
    seedStored();
    await getDb();
    await cacheSet("plan", { x: 1 });
    const claim = vi.spyOn(dbModule, "claimCacheFor");
    auth.getSession.mockResolvedValue({
      data: { session: null },
      error: offlineError(),
    });

    const { result } = renderHook(() => useAuth());
    // auth-js's listener gets INITIAL_SESSION(null) when its own getSession
    // errored; the old code treated it as a sign-out.
    act(() => emit("INITIAL_SESSION", null));
    await flush();

    expect(result.current.loading).toBe(false);
    expect(result.current.session?.user.id).toBe("user-A");
    expect(claim).not.toHaveBeenCalledWith(null);
    expect(await cacheGet("plan")).toEqual({ x: 1 });
    expect(localStorage.getItem(OWNER)).toBe("user-A");
  });

  it("the listener's null arriving AFTER the boot answer does not undo it either", async () => {
    seedStored();
    auth.getSession.mockResolvedValue({
      data: { session: null },
      error: offlineError(),
    });
    const { result } = renderHook(() => useAuth());
    await flush();
    act(() => emit("INITIAL_SESSION", null));
    await flush();
    expect(result.current.session?.user.id).toBe("user-A");
  });

  it("a genuine signed-out cold start still lands on null and clears the owner", async () => {
    seedStored();
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const { result } = renderHook(() => useAuth());
    act(() => emit("INITIAL_SESSION", null));
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.session).toBeNull();
    expect(localStorage.getItem(OWNER)).toBeNull();
  });

  it("a real SIGNED_OUT still clears the cache", async () => {
    seedStored();
    await getDb();
    await cacheSet("plan", { x: 1 });
    auth.getSession.mockResolvedValue({
      data: { session: storedSession() },
      error: null,
    });
    const { result } = renderHook(() => useAuth());
    await flush();
    expect(result.current.session?.user.id).toBe("user-A");
    act(() => emit("SIGNED_OUT", null));
    await flush();
    expect(result.current.session).toBeNull();
    expect(await cacheGet("plan")).toBeUndefined();
  });
});

describe("NEW-CORE-1: an offline cold start does not sit on the splash", () => {
  it("draws the stored session after the short wait while getSession hangs", async () => {
    seedStored();
    auth.getSession.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAuth());
    await flush();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await advance(3000);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.session?.user.id).toBe("user-A");
  });

  it("waits far less when the browser already says it is offline", async () => {
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    seedStored();
    auth.getSession.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await advance(400);
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.session?.user.id).toBe("user-A");
  });

  it("with nothing stored there is nothing to draw, so it keeps waiting for the answer", async () => {
    auth.getSession.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await advance(10_000);
    });
    expect(result.current.loading).toBe(true);
  });

  it("the real answer overrides the provisional one: a genuine sign-out clears the shell", async () => {
    seedStored();
    let resolve!: (v: unknown) => void;
    auth.getSession.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await advance(3000);
    });
    expect(result.current.session?.user.id).toBe("user-A");
    await act(async () => {
      resolve({ data: { session: null }, error: null });
      await advance(0);
    });
    expect(result.current.session).toBeNull();
  });

  it("a TOKEN_REFRESHED after the provisional answer carries the live session", async () => {
    seedStored();
    auth.getSession.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await advance(3000);
    });
    const live = { ...storedSession(), access_token: "fresh" };
    act(() => emit("TOKEN_REFRESHED", live));
    await flush();
    expect(result.current.session?.access_token).toBe("fresh");
  });
});

describe("CORE-12: getSession rejecting", () => {
  it("resolves loading from the stored session instead of hanging on the splash", async () => {
    seedStored();
    auth.getSession.mockRejectedValue(new Error("lock timeout"));
    const { result } = renderHook(() => useAuth());
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.session?.user.id).toBe("user-A");
  });

  it("with nothing stored it resolves to signed out", async () => {
    auth.getSession.mockRejectedValue(new Error("lock timeout"));
    const { result } = renderHook(() => useAuth());
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.session).toBeNull();
  });
});

describe("CORE-4: the UI waits for the cache claim", () => {
  it("does not render the new user's session until the previous owner's cache is cleared", async () => {
    localStorage.setItem(OWNER, "user-A");
    await getDb();
    await cacheSet("plan", { owner: "A" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = dbModule.claimCacheFor;
    vi.spyOn(dbModule, "claimCacheFor").mockImplementation(async (id) => {
      await gate;
      return real(id);
    });
    auth.getSession.mockResolvedValue({
      data: { session: storedSession("user-B") },
      error: null,
    });
    const { result } = renderHook(() => useAuth());
    await flush();
    expect(result.current.loading).toBe(true);
    expect(result.current.session).toBeNull();
    await act(async () => {
      release();
      await advance(0);
    });
    expect(result.current.session?.user.id).toBe("user-B");
    expect(await cacheGet("plan")).toBeUndefined();
  });
});
