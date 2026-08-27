import { describe, expect, it } from "vitest";
import {
  formatMonth,
  formatRxTarget,
  formatSessionDate,
  formatShortDate,
  formatStoredTwin,
} from "./format";
import type { ResolvedPrescriptionRow } from "./types";

// A DATE-ONLY string is a calendar day, not an instant. `new Date("2026-08-24")`
// parses it as UTC midnight, which is 2026-08-23 17:00 in PDT — every label
// west of Greenwich then reads a day early. These tests pin the local reading.
describe("date-only strings parse as local days", () => {
  it("formatShortDate keeps the calendar day (v_weekly_volume.week_start)", () => {
    expect(formatShortDate("2026-08-24")).toBe("8/24");
    expect(formatShortDate("2026-01-01")).toBe("1/1");
    // the boundary that used to shift: the 1st of a month
    expect(formatShortDate("2026-03-01")).toBe("3/1");
  });

  it("formatSessionDate keeps the weekday", () => {
    // 2026-08-24 is a Monday
    expect(formatSessionDate("2026-08-24")).toBe("MON 24 AUG");
  });

  it("formatMonth keeps the month across a month boundary", () => {
    expect(formatMonth("2026-03-01")).toBe("MAR");
  });

  it("still parses full timestamps natively", () => {
    const noon = new Date(2026, 7, 24, 12, 0, 0).toISOString();
    expect(formatShortDate(noon)).toBe("8/24");
    expect(formatSessionDate(noon)).toBe("MON 24 AUG");
  });

  it("accepts Date objects unchanged", () => {
    expect(formatShortDate(new Date(2026, 7, 24))).toBe("8/24");
  });
});

const rx = (over: Partial<ResolvedPrescriptionRow>): ResolvedPrescriptionRow =>
  ({
    id: "p1",
    planned_workout_id: "w1",
    exercise_id: "e1",
    exercise_name: "Squat",
    position: 0,
    sets: 3,
    reps_min: 5,
    reps_max: 5,
    rest_seconds: null,
    notes: null,
    load_kg: null,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: null,
    plate_load_kg: null,
    superset_group: null,
    ...over,
  }) as ResolvedPrescriptionRow;

describe("formatRxTarget is the one prescription formatter", () => {
  it("renders sets, reps and the plate-rounded load", () => {
    expect(
      formatRxTarget(rx({ resolved_load_kg: 101, plate_load_kg: 100 }), "kg"),
    ).toBe("3×5 @ 100 kg");
  });

  it("renders a rep range", () => {
    expect(formatRxTarget(rx({ reps_min: 3, reps_max: 5 }), "kg")).toBe(
      "3×3-5",
    );
  });

  it("falls back to the percentage when no training max resolves it", () => {
    expect(formatRxTarget(rx({ load_pct_tm: 80 }), "kg")).toBe("3×5 @ 80% TM");
  });

  it("converts to the display unit", () => {
    expect(
      formatRxTarget(rx({ resolved_load_kg: 100, plate_load_kg: 100 }), "lb"),
    ).toBe("3×5 @ 220.5 lb");
  });
});

// The unit twin under a load field was hand-rolled on three screens. It is
// the app's only statement of the kg-storage contract, so the three must not
// be able to word it differently.
describe("formatStoredTwin", () => {
  it("names the STORED value when the user is typing lb", () => {
    expect(formatStoredTwin(102.0583, "lb")).toBe("102.1 kg stored");
    expect(formatStoredTwin(60, "lb")).toBe("60 kg stored");
  });

  it("gives the lb equivalent when the user is typing kg", () => {
    expect(formatStoredTwin(100, "kg")).toBe("220.5 lb");
    expect(formatStoredTwin(0, "kg")).toBe("0 lb");
  });
});
