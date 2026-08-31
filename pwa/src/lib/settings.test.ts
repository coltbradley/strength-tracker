// The v0 -> v1 migration is the test that matters most here: an existing
// user's plate inventory, bar, rest and per-exercise bars must survive the
// upgrade to the envelope. Everything else is validator coverage.
//
// Runs on the node environment with an in-memory Storage stub rather than
// jsdom: node >=22 defines a global `localStorage` that shadows jsdom's, so a
// jsdom run would silently exercise the "storage unavailable" path instead of
// the real one.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BAR_KG,
  addBar,
  addPlate,
  clearExercisePref,
  getBarInventory,
  getBarKg,
  getDefaultRestSeconds,
  getExerciseBarKg,
  getExercisePref,
  getExerciseRestSeconds,
  getExerciseStepKg,
  getLoadStepKg,
  getPlatesOnHand,
  getSetting,
  getUnit,
  getWeekStartsOn,
  pruneExercisePrefs,
  reloadSettings,
  removeBar,
  removePlate,
  resetAllSettings,
  resetSetting,
  setExerciseBarKg,
  setExercisePref,
  setLoadStepKg,
  setSetting,
  setUnit,
  subscribeSettings,
} from "./settings";
import { kgToLb, lbToKg } from "./units";

const ENVELOPE = "strength-log.settings";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function envelope(): { v: number; values: Record<string, unknown> } {
  return JSON.parse(localStorage.getItem(ENVELOPE) ?? "null") as {
    v: number;
    values: Record<string, unknown>;
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  reloadSettings();
});

afterEach(() => {
  vi.unstubAllGlobals();
  reloadSettings();
});

describe("defaults", () => {
  it("reads defaults with empty storage", () => {
    expect(getUnit()).toBe("kg");
    expect(getDefaultRestSeconds()).toBe(120);
    expect(getSetting("autoStartRest")).toBe(true);
    expect(getWeekStartsOn()).toBe(1);
    expect(getPlatesOnHand("kg")).toEqual([25, 20, 15, 10, 5, 2.5, 1.25]);
    expect(getBarKg("kg")).toBe(20);
    expect(kgToLb(getBarKg("lb"))).toBeCloseTo(45, 10);
    expect(getLoadStepKg("kg", false)).toBe(2.5);
    expect(getLoadStepKg("kg", true)).toBe(0.5);
    expect(kgToLb(getLoadStepKg("lb", false))).toBeCloseTo(5, 10);
    expect(kgToLb(getLoadStepKg("lb", true))).toBeCloseTo(1, 10);
  });

  it("returns a stable snapshot identity for object settings", () => {
    // useSyncExternalStore compares with Object.is; a fresh array per read
    // would loop forever.
    expect(getPlatesOnHand("kg")).toBe(getPlatesOnHand("kg"));
    expect(getSetting("plates")).toBe(getSetting("plates"));
  });
});

describe("v0 -> v1 migration off the pre-registry keys", () => {
  it("carries a configured plate inventory, bar, rest and unit across", () => {
    // exactly what the old build wrote
    localStorage.setItem("strength-log.unit", "lb");
    localStorage.setItem(
      "strength-log.plates",
      JSON.stringify({
        kg: [25, 20, 10],
        lb: [45, 25, 5].map(lbToKg),
      }),
    );
    localStorage.setItem(
      "strength-log.bar",
      JSON.stringify({ kg: 15, lb: lbToKg(35) }),
    );
    localStorage.setItem("strength-log.defaultRest", "210");
    localStorage.setItem(
      "strength-log.exerciseBar",
      JSON.stringify({ "leg-press": 0, squat: 20 }),
    );
    reloadSettings();

    expect(getUnit()).toBe("lb");
    expect(getDefaultRestSeconds()).toBe(210);
    expect(getPlatesOnHand("kg")).toEqual([25, 20, 10]);
    expect(getPlatesOnHand("lb").map(kgToLb).map(Math.round)).toEqual([
      45, 25, 5,
    ]);
    expect(getBarKg("kg")).toBe(15);
    expect(kgToLb(getBarKg("lb"))).toBeCloseTo(35, 10);
    expect(getExercisePref("squat").barKg).toBe(20);
    expect(getExercisePref("leg-press").barKg).toBe(0);
  });

  it("does not delete the legacy keys (rollback still reads them)", () => {
    localStorage.setItem("strength-log.unit", "lb");
    localStorage.setItem("strength-log.defaultRest", "90");
    reloadSettings();
    getUnit();
    setSetting("defaultRest", 150);
    expect(localStorage.getItem("strength-log.unit")).toBe("lb");
    expect(localStorage.getItem("strength-log.defaultRest")).toBe("90");
  });

  it("persists the migrated values into a current envelope on first write", () => {
    localStorage.setItem("strength-log.defaultRest", "240");
    reloadSettings();
    setSetting("weekStartsOn", 0);
    const env = envelope();
    // Whatever the current envelope version is: the v0 keys must survive every
    // migration that has been added since, not just the first one.
    expect(env.v).toBe(2);
    expect(env.values.defaultRest).toBe(240);
    expect(env.values.weekStartsOn).toBe(0);
  });

  it("does not run again once an envelope exists", () => {
    localStorage.setItem(
      ENVELOPE,
      JSON.stringify({ v: 1, values: { defaultRest: 60 } }),
    );
    localStorage.setItem("strength-log.defaultRest", "240");
    reloadSettings();
    expect(getDefaultRestSeconds()).toBe(60);
  });

  it("keeps envelope values when a legacy key also exists", () => {
    localStorage.setItem(
      ENVELOPE,
      JSON.stringify({ v: 0, values: { unit: "kg" } }),
    );
    localStorage.setItem("strength-log.unit", "lb");
    reloadSettings();
    expect(getUnit()).toBe("kg");
  });

  it("survives a corrupt envelope without losing the legacy config", () => {
    localStorage.setItem(ENVELOPE, "{not json");
    localStorage.setItem("strength-log.defaultRest", "300");
    reloadSettings();
    expect(getDefaultRestSeconds()).toBe(300);
  });

  it("leaves a newer envelope alone instead of downgrading it", () => {
    localStorage.setItem(
      ENVELOPE,
      JSON.stringify({ v: 99, values: { defaultRest: 45, futureThing: 1 } }),
    );
    reloadSettings();
    expect(getDefaultRestSeconds()).toBe(45);
  });
});

describe("validators", () => {
  it("falls back to the default for junk", () => {
    localStorage.setItem(
      ENVELOPE,
      JSON.stringify({
        v: 1,
        values: {
          unit: "stone",
          defaultRest: -5,
          autoStartRest: "yes",
          weekStartsOn: 12,
          plates: "nope",
        },
      }),
    );
    reloadSettings();
    expect(getUnit()).toBe("kg");
    expect(getDefaultRestSeconds()).toBe(120);
    expect(getSetting("autoStartRest")).toBe(true);
    expect(getWeekStartsOn()).toBe(1);
    expect(getPlatesOnHand("kg")).toEqual([25, 20, 15, 10, 5, 2.5, 1.25]);
  });

  it("repairs one corrupt half of a per-unit pair without losing the other", () => {
    localStorage.setItem(
      ENVELOPE,
      JSON.stringify({
        v: 1,
        values: { plates: { kg: [30, 20], lb: "junk" } },
      }),
    );
    reloadSettings();
    expect(getPlatesOnHand("kg")).toEqual([30, 20]);
    expect(getPlatesOnHand("lb").length).toBeGreaterThan(0);
  });

  it("drops out-of-range and duplicate plate values, sorts heaviest first", () => {
    localStorage.setItem(
      ENVELOPE,
      JSON.stringify({
        v: 1,
        values: {
          plates: { kg: [5, 1e9, -2, 20, 20, "x", null, 2.5], lb: [] },
        },
      }),
    );
    reloadSettings();
    expect(getPlatesOnHand("kg")).toEqual([20, 5, 2.5]);
    // an empty inventory is legitimate ("bar only") and is preserved
    expect(getPlatesOnHand("lb")).toEqual([]);
  });

  it("rejects an invalid write and keeps the old value", () => {
    expect(setSetting("defaultRest", 99999)).toBe(false);
    expect(getDefaultRestSeconds()).toBe(120);
    expect(setSetting("unit", "stone" as never)).toBe(false);
    expect(getUnit()).toBe("kg");
  });

  it("never accepts an empty bar inventory", () => {
    localStorage.setItem(
      ENVELOPE,
      JSON.stringify({ v: 1, values: { bars: { kg: [], lb: [] } } }),
    );
    reloadSettings();
    expect(getBarInventory("kg")).toEqual([20, 15, 10]);
  });
});

describe("inventories", () => {
  it("adds and removes plates with validation", () => {
    expect(addPlate("kg", 0.5)).toBe(true);
    expect(getPlatesOnHand("kg")[0]).toBe(25);
    expect(getPlatesOnHand("kg")).toContain(0.5);
    expect(addPlate("kg", 0.5)).toBe(false); // duplicate
    expect(addPlate("kg", 0)).toBe(false); // zero
    expect(addPlate("kg", 5000)).toBe(false); // absurd
    removePlate("kg", 25);
    expect(getPlatesOnHand("kg")).not.toContain(25);
  });

  it("adds a custom bar and selects it", () => {
    expect(addBar("kg", 25)).toBe(true); // trap bar
    expect(getBarInventory("kg")).toEqual([25, 20, 15, 10]);
    expect(getBarKg("kg")).toBe(25);
    expect(addBar("kg", 25)).toBe(false);
    expect(addBar("kg", MAX_BAR_KG + 1)).toBe(false);
  });

  it("refuses to remove the last bar and reselects when the chosen one goes", () => {
    setSetting("bars", { kg: [20], lb: [lbToKg(45)] });
    expect(removeBar("kg", 20)).toBe(false);
    setSetting("bars", { kg: [20, 15], lb: [lbToKg(45)] });
    setBar(20);
    expect(removeBar("kg", 20)).toBe(true);
    expect(getBarKg("kg")).toBe(15);
  });

  function setBar(kg: number): void {
    setSetting("bar", { ...getSetting("bar"), kg });
  }

  it("falls back to the nearest bar when the selection is not in stock", () => {
    setSetting("bars", { kg: [20, 15], lb: [lbToKg(45)] });
    setSetting("bar", { kg: 14.5, lb: lbToKg(45) });
    expect(getBarKg("kg")).toBe(15);
  });
});

describe("unit switch repairs bar selections", () => {
  it("remaps the global bar and every per-exercise override", () => {
    setExerciseBarKg("squat", 20); // kg catalogue
    setExerciseBarKg("leg-press", 0); // no bar, unit independent
    setUnit("lb");

    // 20 kg is not an lb-catalogue bar; the nearest is the 45 lb bar
    expect(kgToLb(getBarKg("lb"))).toBeCloseTo(45, 6);
    expect(kgToLb(getExercisePref("squat").barKg as number)).toBeCloseTo(45, 6);
    // "no bar" is never remapped
    expect(getExercisePref("leg-press").barKg).toBe(0);
  });
});

describe("per-exercise preferences", () => {
  it("merges patches and drops an emptied record", () => {
    setExercisePref("squat", { restSeconds: 240, loadStepKg: 5 });
    expect(getExercisePref("squat")).toEqual({
      restSeconds: 240,
      loadStepKg: 5,
    });
    setExercisePref("squat", { restSeconds: undefined });
    expect(getExercisePref("squat")).toEqual({ loadStepKg: 5 });
    setExercisePref("squat", { loadStepKg: undefined });
    expect(getExercisePref("squat")).toEqual({});
    expect(getSetting("exercisePrefs")).toEqual({});
  });

  it("sanitises stored junk on read", () => {
    localStorage.setItem(
      ENVELOPE,
      JSON.stringify({
        v: 1,
        values: {
          exercisePrefs: {
            squat: { barKg: 20, restSeconds: 240 },
            bench: { barKg: "heavy", restSeconds: 99999, loadStepKg: -1 },
            press: "not an object",
            "": { barKg: 20 },
            row: { barKg: 20, junkField: true },
          },
        },
      }),
    );
    reloadSettings();
    const prefs = getSetting("exercisePrefs");
    expect(prefs.squat).toEqual({ barKg: 20, restSeconds: 240 });
    // every field invalid -> the whole entry goes
    expect(prefs.bench).toBeUndefined();
    expect(prefs.press).toBeUndefined();
    expect(prefs[""]).toBeUndefined();
    // unknown fields are stripped, valid ones survive
    expect(prefs.row).toEqual({ barKg: 20 });
  });

  it("resolves rest as bracket -> exercise -> global", () => {
    setSetting("defaultRest", 120);
    setExercisePref("squat", { restSeconds: 240 });
    expect(getExerciseRestSeconds("squat", 90)).toBe(90);
    expect(getExerciseRestSeconds("squat", null)).toBe(240);
    expect(getExerciseRestSeconds("curl", null)).toBe(120);
    expect(getExerciseRestSeconds(null, null)).toBe(120);
  });

  it("overrides the coarse step only, never the fine one", () => {
    setExercisePref("db-press", { loadStepKg: lbToKg(5) });
    expect(kgToLb(getExerciseStepKg("db-press", "lb", false))).toBeCloseTo(
      5,
      10,
    );
    expect(kgToLb(getExerciseStepKg("db-press", "lb", true))).toBeCloseTo(
      1,
      10,
    );
    expect(getExerciseStepKg("squat", "kg", false)).toBe(2.5);
    expect(getExerciseStepKg(null, "kg", false)).toBe(2.5);
  });

  it("falls back to the unit bar for barbell movements only", () => {
    expect(getExerciseBarKg("squat", "kg", "barbell")).toBe(20);
    expect(getExerciseBarKg("leg-press", "kg", "machine")).toBe(0);
    setExerciseBarKg("leg-press", 25);
    expect(getExerciseBarKg("leg-press", "kg", "machine")).toBe(25);
    setExerciseBarKg("leg-press", null);
    expect(getExerciseBarKg("leg-press", "kg", "machine")).toBe(0);
  });

  it("prunes overrides for exercises that no longer exist", () => {
    setExercisePref("squat", { restSeconds: 240 });
    setExercisePref("ghost", { restSeconds: 60 });
    expect(pruneExercisePrefs(["squat", "bench"])).toBe(1);
    expect(getExercisePref("ghost")).toEqual({});
    expect(getExercisePref("squat")).toEqual({ restSeconds: 240 });
    expect(pruneExercisePrefs(["squat", "bench"])).toBe(0);
  });

  it("clears one override outright", () => {
    setExercisePref("squat", { restSeconds: 240 });
    clearExercisePref("squat");
    expect(getExercisePref("squat")).toEqual({});
  });
});

describe("reset and subscription", () => {
  it("resets one setting and all settings", () => {
    setSetting("defaultRest", 300);
    setSetting("weekStartsOn", 0);
    resetSetting("defaultRest");
    expect(getDefaultRestSeconds()).toBe(120);
    expect(getWeekStartsOn()).toBe(0);
    resetAllSettings();
    expect(getWeekStartsOn()).toBe(1);
  });

  it("notifies subscribers on every write", () => {
    let n = 0;
    const off = subscribeSettings(() => (n += 1));
    setSetting("defaultRest", 150);
    setLoadStepKg("kg", false, 1);
    resetSetting("defaultRest");
    off();
    setSetting("defaultRest", 200);
    expect(n).toBe(3);
  });

  it("reset does not touch the legacy keys or logged data", () => {
    localStorage.setItem("strength-log.plates", JSON.stringify({ kg: [20] }));
    reloadSettings();
    resetAllSettings();
    expect(localStorage.getItem("strength-log.plates")).not.toBeNull();
  });
});

describe("v1 -> v2: fallbackLoadKg becomes per-unit fallbackLoad", () => {
  beforeEach(() => {
    localStorage.clear();
    reloadSettings();
  });

  it("carries a customised kg value onto the kg slot", () => {
    localStorage.setItem(
      "strength-log.settings",
      JSON.stringify({ v: 1, values: { fallbackLoadKg: 60 } }),
    );
    reloadSettings();
    expect(getSetting("fallbackLoad").kg).toBe(60);
  });

  it("gives lb mode a round bar instead of a converted one", () => {
    localStorage.setItem(
      "strength-log.settings",
      JSON.stringify({ v: 1, values: { fallbackLoadKg: 60 } }),
    );
    reloadSettings();
    // 45 lb, not 60 kg converted (132.3 lb) and not 20 kg converted (44.1 lb).
    const lbKg = getSetting("fallbackLoad").lb;
    expect(Math.round(lbKg / 0.45359237)).toBe(45);
  });

  it("an untouched v1 envelope lands on both defaults", () => {
    localStorage.setItem(
      "strength-log.settings",
      JSON.stringify({ v: 1, values: {} }),
    );
    reloadSettings();
    expect(getSetting("fallbackLoad").kg).toBe(20);
    expect(Math.round(getSetting("fallbackLoad").lb / 0.45359237)).toBe(45);
  });

  it("does not delete the old key, so a rollback still finds it", () => {
    localStorage.setItem(
      "strength-log.settings",
      JSON.stringify({ v: 1, values: { fallbackLoadKg: 60 } }),
    );
    reloadSettings();
    setSetting("fallbackReps", 5); // force a persist
    const env = JSON.parse(
      localStorage.getItem("strength-log.settings") ?? "{}",
    ) as { v: number; values: Record<string, unknown> };
    expect(env.v).toBe(2);
    expect(env.values.fallbackLoadKg).toBe(60);
  });
});
