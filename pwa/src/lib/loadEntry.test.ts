// The arithmetic that keeps `sets.load_kg` honest. The failure this guards
// against is silent: a per-side set stored as the typed number (or a
// single-arm set stored doubled) corrupts tonnage and e1RM for good, because
// `sets` is append-only and can never be corrected.

import { afterEach, describe, expect, it } from "vitest";
import {
  defaultLoadEntry,
  enteredKg,
  getLoadEntryOverride,
  loadEntryForSet,
  offersLoadEntry,
  resolveLoadEntry,
  totalKg,
} from "./loadEntry";
import {
  getExerciseRestSeconds,
  resetAllSettings,
  setExerciseLoadEntry,
  setExercisePref,
  setSetting,
} from "./settings";

afterEach(() => {
  resetAllSettings();
});

describe("defaultLoadEntry", () => {
  it("calls a dumbbell movement a pair", () => {
    expect(defaultLoadEntry("dumbbell", "Seated Dumbbell Press")).toBe(
      "per_side",
    );
    expect(defaultLoadEntry("dumbbell", "Bulgarian Split Squat")).toBe(
      "per_side",
    );
  });

  it("calls one-limb dumbbell work TOTAL — one bell IS the whole system", () => {
    for (const name of [
      "One-Arm Dumbbell Row",
      "Single Arm Overhead Press",
      "Single-Leg Romanian Deadlift",
      "1-Arm Dumbbell Snatch",
      "Alternating Dumbbell Curl",
      "Unilateral Farmer Carry",
    ]) {
      expect(defaultLoadEntry("dumbbell", name)).toBe("total");
    }
  });

  it("never guesses per side for a bar, a stack or a body", () => {
    expect(defaultLoadEntry("barbell", "Back Squat")).toBe("total");
    expect(defaultLoadEntry("machine", "Leg Press")).toBe("total");
    expect(defaultLoadEntry("cable", "Triceps Pushdown")).toBe("total");
    expect(defaultLoadEntry("kettlebells", "Kettlebell Swing")).toBe("total");
    expect(defaultLoadEntry(null, "Something Unknown")).toBe("total");
  });
});

describe("resolveLoadEntry", () => {
  const base = { equipment: "dumbbell", name: "Dumbbell Bench Press" };

  it("falls back to the equipment guess when nothing is asserted", () => {
    expect(resolveLoadEntry(base)).toBe("per_side");
  });

  it("lets the prescription assert the convention", () => {
    expect(resolveLoadEntry({ ...base, prescribed: "total" })).toBe("total");
    expect(
      resolveLoadEntry({
        equipment: "barbell",
        name: "Trap Bar Deadlift",
        prescribed: "per_side",
      }),
    ).toBe("per_side");
  });

  it("puts the user's own choice above the coach's", () => {
    expect(
      resolveLoadEntry({ ...base, prescribed: "per_side", override: "total" }),
    ).toBe("total");
  });
});

describe("offersLoadEntry", () => {
  it("stays silent on a barbell", () => {
    expect(offersLoadEntry({ equipment: "barbell", name: "Back Squat" })).toBe(
      false,
    );
    expect(offersLoadEntry({ equipment: "machine", name: "Leg Press" })).toBe(
      false,
    );
  });

  it("appears for hand-held implements", () => {
    expect(
      offersLoadEntry({ equipment: "dumbbell", name: "One-Arm Row" }),
    ).toBe(true);
    expect(
      offersLoadEntry({ equipment: "kettlebells", name: "Goblet Squat" }),
    ).toBe(true);
  });

  it("appears wherever a prescription or the user already asserted per side", () => {
    expect(
      offersLoadEntry({
        equipment: "barbell",
        name: "Landmine Press",
        prescribed: "per_side",
      }),
    ).toBe(true);
    expect(
      offersLoadEntry({
        equipment: "barbell",
        name: "Landmine Press",
        override: "total",
      }),
    ).toBe(true);
  });
});

describe("entered <-> total", () => {
  it("doubles a pair and leaves a single system alone", () => {
    expect(totalKg(30, "per_side")).toBe(60);
    expect(totalKg(30, "total")).toBe(30);
    expect(enteredKg(60, "per_side")).toBe(30);
    expect(enteredKg(60, "total")).toBe(60);
  });

  it("round-trips", () => {
    for (const kg of [2.5, 22.5, 30, 47.5, 100]) {
      expect(enteredKg(totalKg(kg, "per_side"), "per_side")).toBe(kg);
      expect(enteredKg(totalKg(kg, "total"), "total")).toBe(kg);
    }
  });
});

describe("loadEntryForSet", () => {
  it("never writes null for a new set", () => {
    expect(loadEntryForSet("total", 60)).toBe("total");
    expect(loadEntryForSet("per_side", 60)).toBe("per_side");
  });

  it("refuses per_side on a bodyweight set — the DB check would too", () => {
    expect(loadEntryForSet("per_side", 0)).toBe("total");
  });
});

describe("the per-exercise override round-trips through settings", () => {
  it("stores, reads back and clears", () => {
    expect(getLoadEntryOverride("Goblet_Squat")).toBeUndefined();
    setExerciseLoadEntry("Goblet_Squat", "total");
    expect(getLoadEntryOverride("Goblet_Squat")).toBe("total");
    setExerciseLoadEntry("Goblet_Squat", null);
    expect(getLoadEntryOverride("Goblet_Squat")).toBeUndefined();
    expect(getLoadEntryOverride(null)).toBeUndefined();
  });

  it("sits beside the bar and increment without disturbing them", () => {
    setExercisePref("Goblet_Squat", { barKg: 0, loadStepKg: 2 });
    setExerciseLoadEntry("Goblet_Squat", "per_side");
    expect(getLoadEntryOverride("Goblet_Squat")).toBe("per_side");
    setExerciseLoadEntry("Goblet_Squat", null);
    expect(getLoadEntryOverride("Goblet_Squat")).toBeUndefined();
  });
});

// The session screen resolves rest through this chain rather than reading the
// bracket and the global itself (it used to do `bracket ?? global`, which lost
// the per-exercise step entirely).
describe("rest resolution chain, from the session's call site", () => {
  it("prefers the bracket, then the movement, then the global", () => {
    setSetting("defaultRest", 120);
    setExercisePref("Back_Squat", { restSeconds: 240 });
    expect(getExerciseRestSeconds("Back_Squat", 90)).toBe(90);
    expect(getExerciseRestSeconds("Back_Squat", null)).toBe(240);
    expect(getExerciseRestSeconds("Lateral_Raise", null)).toBe(120);
    expect(getExerciseRestSeconds(null, null)).toBe(120);
  });

  it("treats a bracket rest of 0 as an instruction, not as absent", () => {
    setExercisePref("Back_Squat", { restSeconds: 240 });
    expect(getExerciseRestSeconds("Back_Squat", 0)).toBe(0);
  });
});
