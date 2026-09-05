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
      rpe: null,
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
      rpe: null,
    });
    expect(next.set_type).toBe("warmup");
    expect(next.load_entry).toBe("per_side");
  });

  it("carries a rating through unchanged", () => {
    const rated: SetInsert = { ...old, rpe: 8.5 };
    const next = correctedSet(rated, {
      load_kg: 102.5,
      reps: 5,
      set_type: "working",
      load_entry: "total",
      rpe: 8.5,
    });
    expect(next.rpe).toBe(8.5);
  });

  it("rates a set that was logged without one, and clears one that had one", () => {
    // the only way to rate a set after the fact: `sets` is append-only
    expect(
      correctedSet(old, {
        load_kg: 100,
        reps: 5,
        set_type: "working",
        load_entry: "total",
        rpe: 9,
      }).rpe,
    ).toBe(9);
    expect(
      correctedSet(
        { ...old, rpe: 9 },
        {
          load_kg: 100,
          reps: 5,
          set_type: "working",
          load_entry: "total",
          rpe: null,
        },
      ).rpe,
    ).toBeNull();
  });

  it("does not mutate the old row", () => {
    correctedSet(old, {
      load_kg: 1,
      reps: 1,
      set_type: "warmup",
      load_entry: null,
      rpe: 7,
    });
    expect(old.load_kg).toBe(100);
    expect(old.reps).toBe(5);
    expect(old.set_type).toBe("working");
  });
});

describe("isNoopCorrection", () => {
  it("is a no-op when load, reps, type and rating all match", () => {
    expect(
      isNoopCorrection(old, {
        load_kg: 100,
        reps: 5,
        set_type: "working",
        load_entry: "per_side",
        rpe: null,
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
        rpe: null,
      }),
    ).toBe(false);
    expect(
      isNoopCorrection(old, {
        load_kg: 100,
        reps: 5,
        set_type: "warmup",
        load_entry: "total",
        rpe: null,
      }),
    ).toBe(false);
    expect(
      isNoopCorrection(old, {
        load_kg: 97.5,
        reps: 5,
        set_type: "working",
        load_entry: "total",
        rpe: null,
      }),
    ).toBe(false);
  });

  it("is a change when ONLY the rating differs", () => {
    // rating an unrated set, and changing a rating, are both real corrections
    expect(
      isNoopCorrection(old, {
        load_kg: 100,
        reps: 5,
        set_type: "working",
        load_entry: "total",
        rpe: 8,
      }),
    ).toBe(false);
    expect(
      isNoopCorrection(
        { ...old, rpe: 8 },
        {
          load_kg: 100,
          reps: 5,
          set_type: "working",
          load_entry: "total",
          rpe: 8.5,
        },
      ),
    ).toBe(false);
    expect(
      isNoopCorrection(
        { ...old, rpe: 8 },
        {
          load_kg: 100,
          reps: 5,
          set_type: "working",
          load_entry: "total",
          rpe: null,
        },
      ),
    ).toBe(false);
  });

  it("is a no-op when the same rating is re-tapped", () => {
    expect(
      isNoopCorrection(
        { ...old, rpe: 8.5 },
        {
          load_kg: 100,
          reps: 5,
          set_type: "working",
          load_entry: "total",
          rpe: 8.5,
        },
      ),
    ).toBe(true);
  });

  it("treats an ABSENT rating as unrated, not as a change", () => {
    // A row cached before the column, or read through a column list that
    // predates it, carries `undefined`. `undefined === null` is false, so
    // without normalising, saving an unrated set unrated would void it and
    // write a duplicate.
    const legacy: SetInsert = { ...old };
    delete legacy.rpe;
    expect(
      isNoopCorrection(legacy, {
        load_kg: 100,
        reps: 5,
        set_type: "working",
        load_entry: "total",
        rpe: null,
      }),
    ).toBe(true);
  });
});
