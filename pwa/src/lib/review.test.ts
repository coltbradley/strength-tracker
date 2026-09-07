import { describe, expect, it, vi } from "vitest";

// Only the pure rules are under test; the network reader is not. Both
// modules it imports for that are stubbed so the test needs no client and no
// IndexedDB.
vi.mock("./supabase", () => ({ supabase: {} }));
vi.mock("./data", () => ({ QueryError: class QueryError extends Error {} }));

import {
  REVIEW_WINDOW_MS,
  reviewableByDay,
  reviewPrompt,
  type EndedSession,
} from "./review";

const NOW = Date.parse("2026-09-06T09:00:00Z");
const s = (
  id: string,
  planned_workout_id: string | null,
  ended_at: string,
): EndedSession => ({ id, planned_workout_id, ended_at });

describe("reviewableByDay", () => {
  it("offers a session that ended inside the window, keyed by its day", () => {
    const m = reviewableByDay([s("s1", "d1", "2026-09-05T18:00:00Z")], NOW);
    expect(m.get("d1")?.id).toBe("s1");
  });

  it("drops a session older than the window even if the server sent it", () => {
    const old = new Date(NOW - REVIEW_WINDOW_MS - 1000).toISOString();
    expect(reviewableByDay([s("s1", "d1", old)], NOW).size).toBe(0);
  });

  it("keeps a session that ended exactly on the boundary", () => {
    const edge = new Date(NOW - REVIEW_WINDOW_MS).toISOString();
    expect(reviewableByDay([s("s1", "d1", edge)], NOW).size).toBe(1);
  });

  it("has no card for a session without a planned day", () => {
    expect(reviewableByDay([s("s1", null, "2026-09-06T08:00:00Z")], NOW).size).toBe(0);
  });

  it("offers the LATER session when a day was trained twice", () => {
    const m = reviewableByDay(
      [
        s("early", "d1", "2026-09-05T10:00:00Z"),
        s("late", "d1", "2026-09-05T20:00:00Z"),
      ],
      NOW,
    );
    expect(m.get("d1")?.id).toBe("late");
  });

  it("ignores a session that claims to have ended in the future, and garbage", () => {
    const m = reviewableByDay(
      [
        s("future", "d1", "2026-09-07T09:00:00Z"),
        s("junk", "d2", "not a date"),
      ],
      NOW,
    );
    expect(m.size).toBe(0);
  });
});

describe("reviewPrompt", () => {
  it("names the session id and the local date, and nothing else", () => {
    const text = reviewPrompt(s("abc-123", "d1", "2026-09-05T18:00:00Z"));
    expect(text).toContain("abc-123");
    // the local date of the instant, in the app's planned-date style
    expect(text).toMatch(/\b(FRI|SAT) [56] SEP/);
    expect(text.startsWith("Review my session from")).toBe(true);
  });
});
