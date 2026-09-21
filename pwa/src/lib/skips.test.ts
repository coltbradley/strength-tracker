// pwa/src/lib/skips.test.ts
import { describe, expect, it } from "vitest";
import { readSkipsCache, sessionSkipRows, type SkipRecord } from "./skips";

const rec = (over: Partial<SkipRecord> = {}): SkipRecord => ({
  entryKey: "e1",
  prescriptionId: "p1",
  exerciseId: "x1",
  scope: "exercise",
  reason: "knee",
  ...over,
});

describe("readSkipsCache", () => {
  it("treats null as none", () => {
    expect(readSkipsCache(null)).toEqual({});
  });

  it("upgrades a legacy key array", () => {
    expect(readSkipsCache(["e1"])).toEqual({
      e1: {
        entryKey: "e1",
        prescriptionId: null,
        exerciseId: "",
        scope: "exercise",
        reason: null,
      },
    });
  });

  it("passes a record through", () => {
    const map = { e1: rec() };
    expect(readSkipsCache(map)).toEqual(map);
  });
});

describe("sessionSkipRows", () => {
  it("emits every column on every row", () => {
    const [row] = sessionSkipRows("s1", [rec()]);
    expect(row).toEqual({
      id: expect.any(String),
      session_id: "s1",
      prescription_id: "p1",
      exercise_id: "x1",
      scope: "exercise",
      reason: "knee",
    });
  });

  it("keeps warmup scope and a null reason", () => {
    const [row] = sessionSkipRows("s1", [
      rec({ scope: "warmups", reason: null, prescriptionId: null }),
    ]);
    expect(row.scope).toBe("warmups");
    expect(row.reason).toBeNull();
    expect(row.prescription_id).toBeNull();
  });
});
