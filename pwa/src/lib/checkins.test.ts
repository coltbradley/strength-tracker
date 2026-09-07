import { describe, it, expect, vi, beforeEach } from "vitest";

const maybeSingle = vi.fn();
vi.mock("./supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }),
    }),
  },
}));
vi.mock("./data", () => ({ throwIf: vi.fn() }));

import {
  answeredItems,
  checkinRow,
  getReadinessFor,
  painCheckRow,
  readinessRow,
} from "./checkins";

const NOW = "2026-09-07T07:30:00.000Z";

describe("answeredItems", () => {
  it("counts only the six core items that were actually answered", () => {
    expect(answeredItems({})).toBe(0);
    expect(answeredItems({ sleep_hours: 7 })).toBe(1);
    expect(
      answeredItems({ sleep_hours: 7, fatigue: 3, mood: 4 }),
    ).toBe(3);
  });

  // Zero is a measurement, not an absence. This is the same line the schema
  // draws and the reason a mean carries its own count.
  it("counts a zero answer as answered", () => {
    expect(answeredItems({ soreness: 0 as unknown as number })).toBe(1);
  });

  it("does not count explicit nulls, which are cleared answers", () => {
    expect(answeredItems({ sleep_hours: null, mood: null })).toBe(0);
  });

  it("ignores non-core items, which do not trend", () => {
    expect(answeredItems({ bodyweight_kg: 72, note: "fine" })).toBe(0);
  });
});

describe("readinessRow", () => {
  it("carries only what was answered, and never writes 0 for a blank", () => {
    const row = readinessRow("id1", "u1", "2026-09-07", { fatigue: 2 }, NOW);
    expect(row).toEqual({
      id: "id1",
      user_id: "u1",
      local_date: "2026-09-07",
      recorded_at: NOW,
      fatigue: 2,
    });
    // The load-bearing assertion: an unanswered question must not reach the
    // database as a value.
    expect("sleep_hours" in row).toBe(false);
    expect("mood" in row).toBe(false);
  });

  it("accepts a completely empty panel", () => {
    const row = readinessRow("id1", "u1", "2026-09-07", {}, NOW);
    expect(row).toEqual({
      id: "id1",
      user_id: "u1",
      local_date: "2026-09-07",
      recorded_at: NOW,
    });
  });

  it("keeps an explicit null, which clears an answer given earlier", () => {
    const row = readinessRow("id1", "u1", "2026-09-07", { mood: null }, NOW);
    expect(row.mood).toBeNull();
  });

  it("keeps a zero, which is an answer", () => {
    const row = readinessRow("id1", "u1", "2026-09-07", { alcohol_units: 0 }, NOW);
    expect(row.alcohol_units).toBe(0);
  });

  // The id is the caller's, so a correction merges onto the row it corrects
  // rather than colliding with unique (user_id, local_date).
  it("reuses the id it is given so a correction merges", () => {
    const first = readinessRow("stable", "u1", "2026-09-07", { mood: 3 }, NOW);
    const fix = readinessRow("stable", "u1", "2026-09-07", { mood: 5 }, NOW);
    expect(fix.id).toBe(first.id);
    expect(fix.mood).toBe(5);
  });
});

describe("checkinRow / painCheckRow", () => {
  it("stamps the kind and the time", () => {
    const r = checkinRow("c1", "u1", "post_session", { energy: 3 }, NOW);
    expect(r).toMatchObject({ kind: "post_session", energy: 3, recorded_at: NOW });
  });

  // A 24-hour delayed signal is its own row with its own timestamp; it cannot
  // be a field on the run it follows.
  it("makes the next-morning pain check a row of its own", () => {
    const r = painCheckRow("p1", "u1", "next_morning", 5, { episode_id: "e1" }, NOW);
    expect(r).toMatchObject({
      phase: "next_morning",
      nrs_0_10: 5,
      episode_id: "e1",
      captured_at: NOW,
    });
  });
});

describe("getReadinessFor", () => {
  beforeEach(() => maybeSingle.mockReset());

  it("returns today's panel so a correction can reuse its id", async () => {
    maybeSingle.mockResolvedValue({
      data: { id: "r1", local_date: "2026-09-07", recorded_at: NOW, mood: 4 },
      error: null,
    });
    const r = await getReadinessFor("u1", "2026-09-07");
    expect(r?.id).toBe("r1");
  });

  it("returns null when there is none", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getReadinessFor("u1", "2026-09-07")).toBeNull();
  });

  // Opening blank at worst re-asks a question. Refusing to open costs the
  // answer entirely, and this data only accrues forward.
  it("opens blank rather than failing when the read errors", async () => {
    maybeSingle.mockResolvedValue({
      data: null,
      error: { message: "offline", code: "" },
    });
    expect(await getReadinessFor("u1", "2026-09-07")).toBeNull();
  });
});
