import { describe, expect, it } from "vitest";
import {
  formatMonth,
  formatPlate,
  formatRxTarget,
  formatSessionDate,
  formatShortDate,
  formatStoredTwin,
  workoutName,
} from "./format";
import { lbToKg, toDisplay } from "./units";
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

describe("formatPlate", () => {
  // The bug this exists for: toDisplay rounds to one decimal, so the 1.25 kg
  // plate that ships in the DEFAULT kg inventory rendered as "1.3" — in the
  // settings chip, its remove-button aria-label, and the session's
  // "25·20·1.3" rack hint. The lifter matches this string to stamped metal.
  it("names the 1.25 kg plate 1.25, not 1.3", () => {
    expect(formatPlate(1.25, "kg")).toBe("1.25");
    expect(toDisplay(1.25, "kg")).toBe(1.3); // the reason this helper exists
  });

  it("trims trailing zeros so whole plates stay whole", () => {
    expect(formatPlate(20, "kg")).toBe("20");
    expect(formatPlate(2.5, "kg")).toBe("2.5");
    expect(formatPlate(0.5, "kg")).toBe("0.5");
  });

  it("renders the whole default kg inventory as its real labels", () => {
    const labels = [25, 20, 15, 10, 5, 2.5, 1.25].map((p) =>
      formatPlate(p, "kg"),
    );
    expect(labels).toEqual(["25", "20", "15", "10", "5", "2.5", "1.25"]);
  });

  it("renders the lb inventory cleanly in lb mode", () => {
    const labels = [45, 35, 25, 10, 5, 2.5]
      .map(lbToKg)
      .map((p) => formatPlate(p, "lb"));
    expect(labels).toEqual(["45", "35", "25", "10", "5", "2.5"]);
  });

  it("keeps two decimals for an lb plate read in kg mode", () => {
    expect(formatPlate(lbToKg(45), "kg")).toBe("20.41");
  });
});

// A day created in the app starts unnamed. `label ?? fallback` does not fire
// for an EMPTY STRING, so the day rendered with no heading at all — a blank
// where its name should be, on the calendar and in the editor.
describe("workoutName", () => {
  it("uses the label when there is one", () => {
    expect(workoutName({ label: "Leg Day", day_index: 2 })).toBe("Leg Day");
  });

  it("treats blank exactly like null — both mean unnamed", () => {
    expect(workoutName({ label: null, day_index: 0 })).toBe("Workout 1");
    expect(workoutName({ label: "", day_index: 0 })).toBe("Workout 1");
    expect(workoutName({ label: "   ", day_index: 3 })).toBe("Workout 4");
  });

  it("trims, so a stray space does not become the name", () => {
    expect(workoutName({ label: "  Push  ", day_index: 1 })).toBe("Push");
  });
});
