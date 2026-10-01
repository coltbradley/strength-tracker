import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { cacheGet, cacheKeys, cacheSet, resetDbForTests } from "./db";
import { readSessionPrefs, writeSessionPrefs } from "./sessionPrefs";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
});

describe("session preferences", () => {
  it("round-trips by owner and session across a fresh reader", async () => {
    await writeSessionPrefs("owner-a", "session-a", { unit: "lb" });
    expect(await readSessionPrefs("owner-a", "session-a")).toEqual({ unit: "lb" });
  });

  it("isolates the same session id between owners and other sessions", async () => {
    await writeSessionPrefs("owner-a", "shared-session", { unit: "lb" });
    expect(await readSessionPrefs("owner-b", "shared-session")).toEqual({});
    expect(await readSessionPrefs("owner-a", "next-session")).toEqual({});
  });

  it("merges patches without dropping the other and future fields", async () => {
    const key = cacheKeys.sessionPrefs("owner-a", "session-a");
    await cacheSet(key, { unit: "lb", futureChoice: "keep" });
    await Promise.all([
      writeSessionPrefs("owner-a", "session-a", { entryOrder: ["one", "two"] }),
      writeSessionPrefs("owner-a", "session-a", { unit: "kg" }),
    ]);
    expect(await cacheGet(key)).toEqual({ unit: "kg", entryOrder: ["one", "two"], futureChoice: "keep" });
  });

  it("ignores invalid shapes, units, duplicate order keys, and unknown fields", async () => {
    const key = cacheKeys.sessionPrefs("owner-a", "session-a");
    await cacheSet(key, { unit: "stones", entryOrder: ["one", "one", 4, "two"], futureChoice: true });
    expect(await readSessionPrefs("owner-a", "session-a")).toEqual({ entryOrder: ["one", "two"] });
    await cacheSet(key, null);
    expect(await readSessionPrefs("owner-a", "session-a")).toEqual({});
  });

  it("drops a delayed write when its captured identity scope goes stale", async () => {
    let checks = 0;
    await writeSessionPrefs("owner-a", "session-a", { unit: "lb" }, () => ++checks < 3);
    expect(await readSessionPrefs("owner-a", "session-a")).toEqual({});
  });

  it("does not create a shared key for an unknown owner", async () => {
    await writeSessionPrefs("", "session-a", { unit: "lb" });
    expect(await cacheGet("sessionPrefs::session-a")).toBeUndefined();
  });
});
