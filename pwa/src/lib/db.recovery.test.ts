// The device database must recover from a dead or failed connection, and the
// cache bookkeeping around it (claims, invalidation epochs) must be ordered.
// Kept apart from db.test.ts, which pins the cache families.

import "fake-indexeddb/auto";
import { IDBFactory, forceCloseDatabase } from "fake-indexeddb";
import { deleteDB, openDB } from "idb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheDeleteByPrefix,
  cacheEpochFor,
  cacheClearAll,
  cacheGet,
  cacheSet,
  claimCacheFor,
  getDb,
  resetDbForTests,
} from "./db";

const OWNER = "strengthLogCacheOwner";

function stubStorage(seed: Record<string, string> = {}): Map<string, string> {
  const m = new Map<string, string>(Object.entries(seed));
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
  return m;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
});

describe("CORE-5: the IndexedDB connection recovers", () => {
  it("a rejected open is not remembered: the next call retries", async () => {
    // Make the open fail ASYNCHRONOUSLY: another build already moved the
    // database to version 2, so opening version 1 is a VersionError.
    const first = await getDb();
    const name = first.name;
    const newer = await openDB(name, 2);
    newer.close();
    await expect(getDb()).rejects.toBeTruthy();
    // The failure was not cached: once the cause is gone the next call works.
    await deleteDB(name);
    const db = await getDb();
    await db.put("kv", 1, "k");
    expect(await db.get("kv", "k")).toBe(1);
  });

  it("a connection the browser terminated is reopened by the next call", async () => {
    const first = await getDb();
    await first.put("kv", "kept", "k");
    // What WebKit does to a backgrounded PWA: close the connection with the
    // forced flag, which fires `close` (idb's `terminated`).
    forceCloseDatabase(
      first as unknown as Parameters<typeof forceCloseDatabase>[0],
    );
    const second = await getDb();
    expect(second).not.toBe(first);
    expect(await second.get("kv", "k")).toBe("kept");
  });

  it("blocking: yields to a newer open instead of holding the old connection", async () => {
    const first = await getDb();
    await first.put("kv", "kept", "k");
    // A newer build opening version 2 fires versionchange on this connection.
    // Without a `blocking` handler the old connection stays open and the new
    // open never completes.
    const upgraded = await Promise.race([
      openDB(first.name, 2, {
        upgrade(db) {
          db.createObjectStore("later");
        },
      }),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("new open stayed blocked")), 1000),
      ),
    ]);
    expect(upgraded.version).toBe(2);
    expect(await upgraded.get("kv", "k")).toBe("kept");
    upgraded.close();
  });
});

describe("CORE-1/4: claims run one at a time", () => {
  it("concurrent claims for the same new user both see the settled marker", async () => {
    const store = stubStorage({ [OWNER]: "user-A" });
    await cacheSet("plan", { x: 1 });
    const results = await Promise.all([
      claimCacheFor(null),
      claimCacheFor("user-A"),
    ]);
    // Serialized: the first clears (A -> nobody), the second re-claims for A
    // from a cleared cache. Interleaved, the second read the marker mid-clear
    // and reported "no change" while the clear was still running.
    expect(results).toEqual([true, true]);
    expect(store.get(OWNER)).toBe("user-A");
    expect(await cacheGet("plan")).toBeUndefined();
  });

  it("a rejected claim does not wedge the chain", async () => {
    stubStorage({ [OWNER]: "user-A" });
    const first = claimCacheFor("user-B");
    await first;
    expect(await claimCacheFor("user-B")).toBe(false);
  });
});

describe("CORE-3: invalidation epochs", () => {
  it("a prefix delete bumps the epoch of matching keys only", async () => {
    const a0 = cacheEpochFor("sets:abc");
    const b0 = cacheEpochFor("plan");
    await cacheDeleteByPrefix(["sets:"]);
    expect(cacheEpochFor("sets:abc")).not.toBe(a0);
    expect(cacheEpochFor("plan")).toBe(b0);
  });

  it("a full clear bumps every key", async () => {
    const before = cacheEpochFor("anything");
    await cacheClearAll();
    expect(cacheEpochFor("anything")).not.toBe(before);
  });
});
