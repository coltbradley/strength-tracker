import { describe, expect, it } from "vitest";
import { formatSetLine, setPositionLabel } from "./setLine";
import type { SetInsert } from "./types";
import { lbToKg } from "./units";

function set(overrides: Partial<SetInsert> = {}): SetInsert {
  return {
    id: "s1",
    session_id: "sess",
    exercise_id: "bench",
    prescription_id: null,
    set_index: 0,
    set_type: "working",
    load_kg: 60,
    reps: 8,
    performed_at: "2026-10-01T10:00:00.000Z",
    rest_seconds_actual: null,
    load_entry: "total",
    entered_load: null,
    entered_unit: null,
    rpe: null,
    duration_seconds: null,
    ...overrides,
  };
}

describe("formatSetLine", () => {
  it("quotes a loaded set as load × reps in the unit shown", () => {
    expect(formatSetLine(set(), { unit: "kg" })).toBe("60 kg × 8");
    expect(formatSetLine(set(), { unit: "lb" })).toBe("132.3 lb × 8");
  });

  it("quotes a per-hand set per hand, never the doubled total", () => {
    expect(
      formatSetLine(set({ load_kg: 40, load_entry: "per_side" }), { unit: "kg" }),
    ).toBe("20 kg/side × 8");
  });

  it("keeps an authored lb number as authored (M13), not a converted-and-rounded kg value", () => {
    const authored = set({
      load_kg: lbToKg(225.25),
      entered_load: 225.25,
      entered_unit: "lb",
    });
    expect(formatSetLine(authored, { unit: "lb" })).toBe("225.25 lb × 8");
    // in kg there is no authored kg value, so the conversion is the honest answer
    expect(formatSetLine(authored, { unit: "kg" })).toBe("102.2 kg × 8");
  });

  it("does not claim 'total' for a set whose convention is unknown", () => {
    expect(formatSetLine(set({ load_entry: null }), { unit: "kg" })).toBe("60 kg × 8");
  });

  it("bodyweight: reps alone for no load, and added load labelled as added (L6)", () => {
    expect(formatSetLine(set({ load_kg: 0 }), { unit: "kg", bodyweight: true })).toBe("8 reps");
    expect(
      formatSetLine(set({ load_kg: 2.5, reps: 15 }), { unit: "kg", bodyweight: true }),
    ).toBe("15 reps · +2.5 kg added");
  });

  it("timed: a hold reads as a duration, never 'x 0' (M12), with any carried load", () => {
    expect(
      formatSetLine(set({ load_kg: 0, reps: 0, duration_seconds: 45 }), {
        unit: "kg",
        tracking: "time",
      }),
    ).toBe("0:45 held");
    expect(
      formatSetLine(set({ load_kg: 24, reps: 0, duration_seconds: 30 }), {
        unit: "kg",
        tracking: "time",
      }),
    ).toBe("24 kg · 0:30 held");
  });

  it("a tick has no numbers", () => {
    expect(formatSetLine(set({ load_kg: 0, reps: 0 }), { unit: "kg", tracking: "done" })).toBe("Done");
  });
});

describe("setPositionLabel", () => {
  it("counts warmups and working sets separately", () => {
    const sets = [
      set({ id: "w", set_index: 0, set_type: "warmup" }),
      set({ id: "a", set_index: 1 }),
      set({ id: "b", set_index: 2 }),
    ];
    expect(setPositionLabel(sets[0], sets).text).toBe("warmup 1");
    expect(setPositionLabel(sets[1], sets).text).toBe("set 1");
    expect(setPositionLabel(sets[2], sets).text).toBe("set 2");
  });

  it("a correction keeps its original's place (same set_index)", () => {
    const sets = [
      set({ id: "a", set_index: 0 }),
      set({ id: "b2", set_index: 1 }),
    ];
    expect(setPositionLabel(sets[1], sets).number).toBe(2);
  });

  it("does not count across a swap: each exercise's run starts at 1", () => {
    const sets = [
      set({ id: "a", set_index: 0, exercise_id: "planned" }),
      set({ id: "b", set_index: 0, exercise_id: "chosen" }),
    ];
    expect(setPositionLabel(sets[1], sets).number).toBe(1);
  });
});
