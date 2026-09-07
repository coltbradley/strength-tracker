import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
vi.mock("./supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
    }),
  },
}));
vi.mock("./errors", () => ({ reportError: vi.fn() }));

import { getCoachAccess } from "./coachAccess";

describe("getCoachAccess", () => {
  beforeEach(() => maybeSingle.mockReset());

  it("is on when there is no row, which is the default state", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getCoachAccess("u1")).toEqual({ enabled: true, reason: null });
  });

  it("is off when a row says so, and carries the reason to show", async () => {
    maybeSingle.mockResolvedValue({
      data: { enabled: false, reason: "paused while we sort out the bill" },
      error: null,
    });
    expect(await getCoachAccess("u1")).toEqual({
      enabled: false,
      reason: "paused while we sort out the bill",
    });
  });

  it("is off with no reason when the row gives none", async () => {
    maybeSingle.mockResolvedValue({
      data: { enabled: false, reason: null },
      error: null,
    });
    expect(await getCoachAccess("u1")).toEqual({ enabled: false, reason: null });
  });

  // The load-bearing one. A failed read is "we could not ask", never "no": the
  // edge function is the boundary and will answer 403 on its own, so a dock
  // that vanishes on a flaky connection costs more than it protects.
  it("is on when the read fails, because that is not an answer", async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "network", code: "" },
    });
    expect(await getCoachAccess("u1")).toEqual({ enabled: true, reason: null });
  });

  // The catch, reached from inside the function rather than from the mock.
  // A mock that throws is captured by vitest as a test error even when the code
  // under test catches it, so this makes the client return an unexpected shape
  // and lets the destructure raise -- which is also the realer failure: a
  // postgrest-js upgrade changing what maybeSingle resolves to.
  it("is on when the client returns a shape it cannot read", async () => {
    maybeSingle.mockResolvedValue(undefined);
    expect(await getCoachAccess("u1")).toEqual({ enabled: true, reason: null });
  });

  it("is on when nobody is signed in, and asks the server nothing", async () => {
    expect(await getCoachAccess(null)).toEqual({ enabled: true, reason: null });
    expect(maybeSingle).not.toHaveBeenCalled();
  });
});
