import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const select = vi.fn();
let nextResult: () => { data: unknown; error: unknown } = () => ({
  data: [],
  error: null,
});

vi.mock("./supabase", () => ({
  supabase: {
    from: () => ({
      select: (cols: string) => {
        select(cols);
        return {
          eq: () => ({
            order: async () => nextResult(),
            limit: async () => nextResult(),
          }),
        };
      },
    }),
  },
}));
vi.mock("./sync", () => ({ outbox: {} }));
const live = vi.hoisted(() => ({ value: true }));
vi.mock("./persistedSession", async (orig) => ({
  ...(await orig<typeof import("./persistedSession")>()),
  storedSessionIsLive: () => live.value,
}));
vi.mock("./errors", () => ({ reportError: vi.fn() }));

import { countServerSessionSets, getServerSessionSets } from "./data";
import { cacheClearAll, cacheGet, cacheSet, cacheKeys } from "./db";

beforeEach(async () => {
  live.value = true;
  select.mockClear();
  await cacheClearAll();
});

describe("getServerSessionSets", () => {
  it("SESS-6: the projection carries duration_seconds", async () => {
    nextResult = () => ({ data: [], error: null });
    await getServerSessionSets("s1");
    expect(select.mock.calls[0]![0]).toContain("duration_seconds");
  });

  it("SESS-4: a failed read with no cache is null for orNull callers, never []", async () => {
    nextResult = () => ({ data: null, error: { message: "boom", code: "" } });
    expect(await getServerSessionSets("s2", { orNull: true })).toBeNull();
  });
});

describe("REVIEW-2: an empty answer without a live session is not an answer", () => {
  const row = { id: "a" };
  it("REVIEW-2: does not overwrite the cached sets and serves them", async () => {
    await cacheSet(cacheKeys.sessionSets("s3"), [row]);
    live.value = false;
    nextResult = () => ({ data: [], error: null });
    expect(await getServerSessionSets("s3")).toEqual([row]);
    expect(await cacheGet(cacheKeys.sessionSets("s3"))).toEqual([row]);
  });

  it("REVIEW-2: with orNull and no cache it is null, not []", async () => {
    live.value = false;
    nextResult = () => ({ data: [], error: null });
    expect(await getServerSessionSets("s4", { orNull: true })).toBeNull();
    expect(await cacheGet(cacheKeys.sessionSets("s4"))).toBeUndefined();
  });

  it("REVIEW-2: a live-session empty answer is still cached", async () => {
    nextResult = () => ({ data: [], error: null });
    expect(await getServerSessionSets("s5")).toEqual([]);
    expect(await cacheGet(cacheKeys.sessionSets("s5"))).toEqual([]);
  });

  it("REVIEW-2: the count throws (unknown) on an empty answer without a live session", async () => {
    live.value = false;
    nextResult = () => ({ data: [], error: null });
    await expect(countServerSessionSets("s6")).rejects.toThrow();
  });

  it("REVIEW-2: the count reports a genuine zero with a live session", async () => {
    nextResult = () => ({ data: [], error: null });
    expect(await countServerSessionSets("s7")).toBe(0);
  });
});
