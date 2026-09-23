import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn(async (_op: unknown) => undefined));
const cacheFail = vi.hoisted(() => ({ bodyweight: false }));

vi.mock("./sync", () => ({
  outbox: {
    enqueue: (op: unknown) => enqueue(op),
  },
}));

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    ...actual,
    cacheGet: async <T,>(key: string): Promise<T | undefined> => {
      if (cacheFail.bodyweight && key === actual.cacheKeys.bodyweight) {
        throw new Error("cache read failed");
      }
      return actual.cacheGet<T>(key);
    },
  };
});

import { recordBodyweight } from "./data";
import { resetDbForTests } from "./db";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  cacheFail.bodyweight = false;
  enqueue.mockReset();
  enqueue.mockImplementation(async () => undefined);
});

describe("recordBodyweight", () => {
  it("returns the weigh-in when the cache update throws after the queue write", async () => {
    cacheFail.bodyweight = true;

    await expect(recordBodyweight(77.1, "2026-09-23T08:00:00.000Z")).resolves.toEqual({
      measured_at: "2026-09-23T08:00:00.000Z",
      weight_kg: 77.1,
      source: "log",
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      kind: "insert",
      table: "bodyweight_log",
      payload: { measured_at: "2026-09-23T08:00:00.000Z", weight_kg: 77.1 },
    });
  });
});
