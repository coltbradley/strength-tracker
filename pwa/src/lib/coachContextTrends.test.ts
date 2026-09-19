// TRENDS and OBSERVATIONS, the two context-block sections built from
// v_trend_digest and coach_observations. Pure formatting only — the reads
// themselves are exercised in coachContext.test.ts's buildCoachContext
// suite, which already has the fake Supabase client this module needs.
import { describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} }));
vi.mock("./settings", () => ({
  getUnit: () => "kg",
  getWeekStartsOn: () => 1,
}));
vi.mock("./data", () => ({ getTrainingPlan: vi.fn() }));

import {
  formatObservations,
  formatTrendsLine,
  type DueObservation,
  type TrendDigest,
} from "./coachContext";

const DIGEST: TrendDigest = {
  bw_latest_kg: 82.3,
  bw_latest_at: "2026-09-15T07:00:00Z",
  bw_7d_mean_kg: 82.1,
  bw_7d_n: 5,
  bw_28d_mean_kg: 81.8,
  bw_28d_n: 18,
  bw_28d_slope_kg_per_week: 0.3,
  energy_14d_mean: 3.6,
  energy_14d_n: 9,
  lifts: [
    {
      exercise_id: "back-squat",
      name: "Barbell Squat",
      e1rm_latest_kg: 140,
      e1rm_4w_ago_kg: 132,
      working_sets_this_week: 12,
      working_sets_last_week: 10,
    },
  ],
};

describe("formatTrendsLine", () => {
  it("says there is not enough data when the digest is null", () => {
    expect(formatTrendsLine(null, "kg")).toBe("\nTRENDS: not enough data yet.");
  });

  it("names bodyweight with its 7d and 28d means, counts and slope", () => {
    const line = formatTrendsLine(
      { ...DIGEST, energy_14d_n: 0, lifts: [] },
      "kg",
    );
    expect(line).toBe(
      "\nTRENDS: bodyweight 82.3 kg (7d avg 82.1 kg, n=5; 28d avg 81.8 kg, " +
        "n=18, +0.3 kg/wk)",
    );
  });

  it("converts to the display unit, including the slope", () => {
    const line = formatTrendsLine(
      { ...DIGEST, energy_14d_n: 0, lifts: [] },
      "lb",
    );
    expect(line).toContain("bodyweight 181.4 lb");
    expect(line).toContain("+0.7 lb/wk");
  });

  it("omits the 28d clause when there are no 28d points yet", () => {
    const line = formatTrendsLine(
      { ...DIGEST, bw_28d_n: 0, energy_14d_n: 0, lifts: [] },
      "kg",
    );
    expect(line).toBe("\nTRENDS: bodyweight 82.3 kg (7d avg 82.1 kg, n=5)");
  });

  it("adds energy only when it has a count", () => {
    const line = formatTrendsLine({ ...DIGEST, lifts: [] }, "kg");
    expect(line).toContain("energy 14d avg 3.6/5 (n=9)");
  });

  it("names each lift with its e1RM, 4-week-ago figure and set counts", () => {
    const line = formatTrendsLine(
      {
        ...DIGEST,
        bw_latest_kg: null,
        bw_7d_n: 0,
        bw_28d_n: 0,
        energy_14d_n: 0,
      },
      "kg",
    );
    expect(line).toBe(
      "\nTRENDS: Barbell Squat e1RM 140 kg (was 132 kg 4w ago), 12 sets " +
        "this wk vs 10 last",
    );
  });

  it("says a lift has no e1RM yet rather than a blank number", () => {
    const line = formatTrendsLine(
      {
        ...DIGEST,
        bw_latest_kg: null,
        bw_7d_n: 0,
        bw_28d_n: 0,
        energy_14d_n: 0,
        lifts: [
          { ...DIGEST.lifts[0], e1rm_latest_kg: null, e1rm_4w_ago_kg: null },
        ],
      },
      "kg",
    );
    expect(line).toContain(
      "Barbell Squat e1RM no e1RM yet, 12 sets this wk vs 10 last",
    );
    expect(line).not.toContain("was");
  });

  it("says not enough data when every field is empty", () => {
    const empty: TrendDigest = {
      bw_latest_kg: null,
      bw_latest_at: null,
      bw_7d_mean_kg: null,
      bw_7d_n: 0,
      bw_28d_mean_kg: null,
      bw_28d_n: 0,
      bw_28d_slope_kg_per_week: null,
      energy_14d_mean: null,
      energy_14d_n: 0,
      lifts: [],
    };
    expect(formatTrendsLine(empty, "kg")).toBe(
      "\nTRENDS: not enough data yet.",
    );
  });
});

describe("formatObservations", () => {
  const OBS: DueObservation[] = [
    {
      id: "aaa",
      topic: "bodyweight",
      observation: "Trending down for three weeks.",
      check_back_on: "2026-09-20",
    },
    {
      id: "bbb",
      topic: "fueling",
      observation: "May be under-eating on training days.",
      check_back_on: null,
    },
  ];

  it("is empty when there is nothing due", () => {
    expect(formatObservations([])).toEqual([]);
  });

  it("lists each item with its id, topic and check-back date", () => {
    const lines = formatObservations(OBS);
    expect(lines[0]).toBe("\nOBSERVATIONS (yours, due for a look):");
    expect(lines[1]).toBe(
      "  - id aaa [bodyweight] Trending down for three weeks. " +
        "(check back 2026-09-20)",
    );
    expect(lines[2]).toBe(
      "  - id bbb [fueling] May be under-eating on training days. " +
        "(no check-back date)",
    );
  });

  it("caps at OBSERVATIONS_CAP, keeping the first five in the order given", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `id${i}`,
      topic: "other",
      observation: `note ${i}`,
      check_back_on: null,
    }));
    const lines = formatObservations(many);
    expect(lines.length).toBe(6); // heading + 5
    expect(lines.join("\n")).not.toContain("id5");
  });
});
