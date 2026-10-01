// getExercisePrefRows must not return a silently truncated list (F9).
import { beforeEach, describe, expect, it, vi } from "vitest";

const pages: Array<Array<{ exercise_id: string }>> = [];
const ranges: Array<[number, number]> = [];

vi.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: () => {
      const q = {
        select: () => q,
        order: () => q,
        range: (a: number, b: number) => {
          ranges.push([a, b]);
          return Promise.resolve({ data: pages.shift() ?? [], error: null });
        },
      };
      return q;
    },
  },
}));

import { getExercisePrefRows } from "./data";

const full = () => Array.from({ length: 1000 }, (_, i) => ({ exercise_id: `e${i}` }));

describe("getExercisePrefRows", () => {
  beforeEach(() => {
    pages.length = 0;
    ranges.length = 0;
  });

  it("pages past the server's row cap until a short page", async () => {
    pages.push(full(), full(), [{ exercise_id: "last" }]);
    const rows = await getExercisePrefRows();
    expect(rows).toHaveLength(2001);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("refuses to hand back a partial read when the ceiling is hit", async () => {
    for (let i = 0; i < 20; i++) pages.push(full());
    await expect(getExercisePrefRows()).rejects.toThrow(/more rows/);
  });
});
