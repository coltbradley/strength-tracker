// Reading the auth library's storage is a coupling, so the contract worth
// pinning is what happens when the coupling BREAKS: every unexpected shape,
// every unreadable store, must come back null and put the app on its old
// behaviour rather than on a half-parsed session.

import { beforeEach, describe, expect, it } from "vitest";
import { readPersistedSession, readPersistedUserId } from "./persistedSession";

const KEY = "sb-abcdefghijklmnop-auth-token";

/** The smallest thing that behaves like Storage. Injected rather than using a
 *  jsdom global, because jsdom only grants localStorage to a real origin and
 *  this suite runs in node. */
function fakeStore(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

const session = (over: Record<string, unknown> = {}) => ({
  access_token: "at",
  refresh_token: "rt",
  expires_at: 1_800_000_000,
  user: { id: "00000000-0000-4000-8000-000000000001", email: "a@b.test" },
  ...over,
});

let store: Storage;
beforeEach(() => {
  store = fakeStore();
});

describe("readPersistedSession", () => {
  it("finds the session under the auth library's key", () => {
    store.setItem(KEY, JSON.stringify(session()));
    expect(readPersistedSession(store)?.user.id).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(readPersistedUserId(store)).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("is null when nothing is stored", () => {
    expect(readPersistedSession(store)).toBeNull();
    expect(readPersistedUserId(store)).toBeNull();
  });

  it("ignores keys that are not the auth token", () => {
    store.setItem("cacheOwner", JSON.stringify(session()));
    store.setItem("settings.v1", JSON.stringify(session()));
    expect(readPersistedSession(store)).toBeNull();
  });

  it("survives a value that is not JSON", () => {
    store.setItem(KEY, "{not json");
    expect(readPersistedSession(store)).toBeNull();
  });

  it("rejects a session with no user id, which is not an identity", () => {
    store.setItem(KEY, JSON.stringify(session({ user: {} })));
    expect(readPersistedSession(store)).toBeNull();
    store.setItem(KEY, JSON.stringify(session({ user: { id: "" } })));
    expect(readPersistedSession(store)).toBeNull();
  });

  it("rejects a session with no refresh token, which cannot recover", () => {
    // Without one there is nothing to refresh when the network returns, so
    // standing in for a live session would strand the app rather than bridge
    // a gap.
    const { refresh_token: _drop, ...rest } = session();
    store.setItem(KEY, JSON.stringify(rest));
    expect(readPersistedSession(store)).toBeNull();
  });

  it("rejects a stored primitive", () => {
    store.setItem(KEY, JSON.stringify("signed-out"));
    expect(readPersistedSession(store)).toBeNull();
    store.setItem(KEY, JSON.stringify(null));
    expect(readPersistedSession(store)).toBeNull();
  });

  it("returns null rather than throwing when storage itself throws", () => {
    // Safari private mode, and the thumbnail/preview contexts that block site
    // data. A boot path that throws here is a white screen.
    const hostile = {
      get length(): number {
        throw new Error("SecurityError");
      },
      key: () => null,
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    } as unknown as Storage;
    expect(() => readPersistedSession(hostile)).not.toThrow();
    expect(readPersistedSession(hostile)).toBeNull();
  });

  it("returns null where there is no storage at all", () => {
    expect(readPersistedSession(undefined)).toBeNull();
    expect(readPersistedUserId(undefined)).toBeNull();
  });

  it("still reads the pre-2.x key name", () => {
    store.setItem("supabase.auth.token", JSON.stringify(session()));
    expect(readPersistedUserId(store)).toBe("00000000-0000-4000-8000-000000000001");
  });
});
