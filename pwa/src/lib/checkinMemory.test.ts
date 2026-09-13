// Fire-and-forget: ask the coach function to read this caller's own
// unprocessed check-in notes. Nothing here may ever surface to the lifter —
// no toast, and no rejected promise a caller has to handle — because a
// check-in already saved successfully; this is bookkeeping that happens to
// ride along afterwards, not something the person did wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { auth: { getSession } } }));
vi.mock("./errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));

import { reportError } from "./errors";
import { notifyCheckinMemory } from "./checkinMemory";

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue({
    data: { session: { access_token: "test-jwt" } },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(reportError).mockReset();
});

/** notifyCheckinMemory is synchronous and fire-and-forget; give its internal
 *  promise a turn to run before asserting on it. */
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("notifyCheckinMemory", () => {
  it("posts to the coach function's checkin-memory route with a bearer token", async () => {
    notifyCheckinMemory();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("/functions/v1/coach/checkin-memory");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer test-jwt",
    );
  });

  it("does nothing when signed out", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    notifyCheckinMemory();
    await settle();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never throws and reports without a toast when the request fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    expect(() => notifyCheckinMemory()).not.toThrow();
    await settle();
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("checkin"),
      { toast: false },
    );
  });

  it("never throws and stays quiet on a non-2xx response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 500 }));
    expect(() => notifyCheckinMemory()).not.toThrow();
    await settle();
    // A failed extraction is not the lifter's problem and not an error
    // worth an operator alert on its own — the route already reports to
    // Sentry server-side. Nothing to assert beyond "did not throw".
  });
});
