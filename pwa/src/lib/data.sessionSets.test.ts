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
          }),
        };
      },
    }),
  },
}));
vi.mock("./sync", () => ({ outbox: {} }));
vi.mock("./errors", () => ({ reportError: vi.fn() }));

import { getServerSessionSets } from "./data";
import { cacheClearAll } from "./db";

beforeEach(async () => {
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
