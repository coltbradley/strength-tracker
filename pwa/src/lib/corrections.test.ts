// A correction must keep the set's PLACE in the workout and change only what
// was lifted. Losing set_index or performed_at here is how a corrected set 2
// used to become set 5.

import { describe, expect, it } from "vitest";
import { correctedSet, isNoopCorrection } from "./corrections";
import type { SetInsert } from "./types";

const old: SetInsert = {
  id: "00000000-0000-4000-8000-000000000001",
  session_id: "sess",
  exercise_id: "Barbell_Squat",
  prescription_id: "rx-1",
  set_index: 1,
  set_type: "working",
  load_kg: 100,
  reps: 5,
  performed_at: "2026-09-04T10:00:00.000Z",
  rest_seconds_actual: 142,
  load_entry: "total",
};

describe("correctedSet", () => {
  it("keeps the old row's place and changes only the numbers", () => {
    const next = correctedSet(old, {
      load_kg: 102.5,
      reps: 4,
      set_type: "working",
      load_entry: "total",
    });
    expect(next.id).not.toBe(old.id);
    expect(next.set_index).toBe(1);
    expect(next.performed_at).toBe(old.performed_at);
    expect(next.rest_seconds_actual).toBe(142);
    expect(next.prescription_id).toBe("rx-1");
    expect(next.session_id).toBe("sess");
    expect(next.exercise_id).toBe("Barbell_Squat");
    expect(next.load_kg).toBe(102.5);
    expect(next.reps).toBe(4);
  });

  it("can retype a set as a warmup, and record how the load was entered", () => {
    const next = correctedSet(old, {
      load_kg: 60,
      reps: 5,
      set_type: "warmup",
      load_entry: "per_side",
    });
    expect(next.set_type).toBe("warmup");
    expect(next.load_entry).toBe("per_side");
  });

  it("does not mutate the old row", () => {
    correctedSet(old, {
      load_kg: 1,
      reps: 1,
      set_type: "warmup",
      load_entry: null,
    });
    expect(old.load_kg).toBe(100);
    expect(old.reps).toBe(5);
    expect(old.set_type).toBe("working");
  });
});

describe("isNoopCorrection", () => {
  it("is a no-op when load, reps and type all match", () => {
    expect(
      isNoopCorrection(old, {
        load_kg: 100,
        reps: 5,
        set_type: "working",
        load_entry: "per_side",
      }),
    ).toBe(true);
  });

  it("is a change when any of load, reps or type differs", () => {
    expect(
      isNoopCorrection(old, {
        load_kg: 100,
        reps: 6,
        set_type: "working",
        load_entry: "total",
      }),
    ).toBe(false);
    expect(
      isNoopCorrection(old, {
        load_kg: 100,
        reps: 5,
        set_type: "warmup",
        load_entry: "total",
      }),
    ).toBe(false);
    expect(
      isNoopCorrection(old, {
        load_kg: 97.5,
        reps: 5,
        set_type: "working",
        load_entry: "total",
      }),
    ).toBe(false);
  });
});
