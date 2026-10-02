// PLAN-10: the History reads share data.ts's online-first helper, so a server
// ANSWER of no is reported and tagged, not passed off as "offline".
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, cache, report } = vi.hoisted(() => ({
  from: vi.fn(),
  cache: new Map<string, unknown>(),
  report: vi.fn(),
}));
vi.mock("./supabase", () => ({ supabase: { from } }));
vi.mock("./sync", () => ({ outbox: {} }));
vi.mock("./errors", () => ({ reportError: report, toast: vi.fn() }));
vi.mock("./db", async (orig) => ({
  ...(await orig<typeof import("./db")>()),
  cacheGet: async (k: string) => cache.get(k),
  cacheSet: async (k: string, v: unknown) => void cache.set(k, v),
}));

import { getWeeklySummary } from "./sessionHistory";

function failing(error: { message: string; code?: string }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "limit"]) b[m] = () => b;
  b.then = (res: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error }).then(res);
  return b;
}

beforeEach(() => {
  cache.clear();
  report.mockClear();
});

describe("PLAN-10: getWeeklySummary", () => {
  it("reports a server error behind a warm cache and tags it stale", async () => {
    cache.set("weekSummary:2026-09-28", { week_start: "2026-09-28" });
    from.mockReturnValue(failing({ message: "column gone", code: "42703" }));
    const r = await getWeeklySummary("2026-09-28");
    expect(r.fromCache).toBe(true);
    expect(r.stale).toBe("error");
    expect(report).toHaveBeenCalled();
  });

  it("an unreachable server is offline, and is not reported", async () => {
    cache.set("weekSummary:2026-09-28", { week_start: "2026-09-28" });
    from.mockReturnValue(failing({ message: "Failed to fetch", code: "" }));
    const r = await getWeeklySummary("2026-09-28");
    expect(r.stale).toBe("offline");
    expect(report).not.toHaveBeenCalled();
  });

  it("rethrows when there is no cache either", async () => {
    from.mockReturnValue(failing({ message: "down", code: "" }));
    await expect(getWeeklySummary("2026-09-28")).rejects.toThrow();
  });
});
