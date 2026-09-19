// Load style is presentation only: which of the six load modes an exercise
// shows. The two real bugs this guards against: Leg Press and Leg
// Extension share the SAME equipment string ("machine") in free-exercise-db
// but need opposite defaults, and Cable Row/Lat Pulldown are tagged
// "cable", not "machine" — a check that only recognised "machine" would
// silently give cable work no icon and no toggle at all.

import { afterEach, describe, expect, it } from "vitest";
import {
  defaultLoadStyle,
  offersLoadStyle,
  resolveLoadStyle,
} from "./loadStyle";
import {
  getExerciseLoadStyle,
  resetAllSettings,
  setExerciseLoadStyle,
} from "./settings";

afterEach(() => {
  resetAllSettings();
});

describe("defaultLoadStyle", () => {
  it("is always plates for a barbell, whatever the name", () => {
    expect(defaultLoadStyle("barbell", "Back Squat")).toBe("plates");
    expect(defaultLoadStyle("barbell", "Barbell Hack Squat")).toBe("plates");
  });

  it("calls the named plate-loaded machines plates, base 0 until set", () => {
    expect(defaultLoadStyle("machine", "Leg Press")).toBe("plates");
    expect(defaultLoadStyle("machine", "Narrow Stance Leg Press")).toBe(
      "plates",
    );
    expect(defaultLoadStyle("machine", "Hack Squat")).toBe("plates");
    expect(defaultLoadStyle("machine", "Narrow Stance Hack Squats")).toBe(
      "plates",
    );
    expect(defaultLoadStyle("machine", "Smith Machine Bench Press")).toBe(
      "plates",
    );
    expect(defaultLoadStyle("machine", "Smith Machine Squat")).toBe("plates");
  });

  // Leg Press, Hack Squat and Leg Extension all carry equipment "machine"
  // in the real seed — the name is the ONLY signal that tells a plate sled
  // apart from a pin stack.
  it("calls every other machine/cable exercise a stack, including Leg Extension", () => {
    expect(defaultLoadStyle("machine", "Leg Extensions")).toBe("stack");
    expect(defaultLoadStyle("machine", "Single-Leg Leg Extension")).toBe(
      "stack",
    );
    expect(defaultLoadStyle("cable", "Seated Cable Rows")).toBe("stack");
    expect(defaultLoadStyle("cable", "Wide-Grip Lat Pulldown")).toBe("stack");
  });

  it("returns an inert default for equipment that never offers the toggle", () => {
    expect(defaultLoadStyle("dumbbell", "Dumbbell Bench Press")).toBe(
      "stack",
    );
    expect(defaultLoadStyle("kettlebells", "Kettlebell Swing")).toBe("stack");
    expect(defaultLoadStyle("body only", "Push-Up")).toBe("stack");
    expect(defaultLoadStyle(null, "Something Custom")).toBe("stack");
  });
});

describe("offersLoadStyle", () => {
  it("is true for machine and cable equipment", () => {
    expect(offersLoadStyle("machine", "Leg Press")).toBe(true);
    expect(offersLoadStyle("cable", "Seated Cable Row")).toBe(true);
  });

  it("is false for a barbell — plates, but no toggle to a stack", () => {
    expect(offersLoadStyle("barbell", "Back Squat")).toBe(false);
  });

  it("is false for hand-held implements, bodyweight and unknown equipment", () => {
    expect(offersLoadStyle("dumbbell", "Dumbbell Row")).toBe(false);
    expect(offersLoadStyle("kettlebells", "Kettlebell Swing")).toBe(false);
    expect(offersLoadStyle("body only", "Push-Up")).toBe(false);
    expect(offersLoadStyle(null, "Something Custom")).toBe(false);
  });
});

describe("resolveLoadStyle", () => {
  it("falls back to the default when nothing is overridden", () => {
    expect(resolveLoadStyle(undefined, "machine", "Leg Press")).toBe(
      "plates",
    );
    expect(resolveLoadStyle(undefined, "cable", "Seated Cable Row")).toBe(
      "stack",
    );
  });

  it("lets the user's own override win", () => {
    expect(resolveLoadStyle("stack", "machine", "Leg Press")).toBe("stack");
    expect(resolveLoadStyle("plates", "cable", "Seated Cable Row")).toBe(
      "plates",
    );
  });
});

describe("the per-exercise override round-trips through settings", () => {
  it("stores, reads back and clears", () => {
    expect(getExerciseLoadStyle("Leg_Press")).toBeUndefined();
    setExerciseLoadStyle("Leg_Press", "stack");
    expect(getExerciseLoadStyle("Leg_Press")).toBe("stack");
    setExerciseLoadStyle("Leg_Press", undefined);
    expect(getExerciseLoadStyle("Leg_Press")).toBeUndefined();
  });
});
