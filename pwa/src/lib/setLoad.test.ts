import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAcceptedAuthoredLoad,
  buildSetLoad,
  isAcceptedAuthoredLoad,
  LoadIntegrityError,
  provenanceForTotal,
  shownLoadValue,
  typedFromDraft,
} from "./setLoad";
import { stagedDisplayLoad, toDisplay } from "./units";

// The database half of the proof (every built load inserted into the real
// trigger, thousands of cases) is scripts/load-integrity.test.mjs. These are
// the pure properties that need no database.

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(7);
const dp = (x: number, p: number) => Math.round(x * 10 ** p) / 10 ** p;

describe("buildSetLoad", () => {
  it("derives the totals the incident sets should have had", () => {
    expect(buildSetLoad({ typedValue: 225, typedUnit: "lb", loadEntry: "total" })).toEqual({
      load_kg: 102.06,
      load_entry: "total",
      entered_load: 225,
      entered_unit: "lb",
    });
    expect(buildSetLoad({ typedValue: 30, typedUnit: "lb", loadEntry: "per_side" }).load_kg).toBe(27.22);
    expect(buildSetLoad({ typedValue: 11.25, typedUnit: "kg", loadEntry: "per_side" }).load_kg).toBe(22.5);
    // Postgres rounds ties away from zero; Math.round(1.005 * 100) is 100
    expect(buildSetLoad({ typedValue: 1.005, typedUnit: "kg", loadEntry: "total" }).load_kg).toBe(1.01);
  });

  it("stores a typed zero as a bodyweight set with no authored pair", () => {
    expect(buildSetLoad({ typedValue: 0, typedUnit: "lb", loadEntry: "per_side" })).toEqual({
      load_kg: 0,
      load_entry: "total",
      entered_load: null,
      entered_unit: null,
    });
  });

  it("refuses what cannot be stored as typed instead of storing something else", () => {
    const bad = (typedValue: number, over = {}) =>
      () => buildSetLoad({ typedValue, typedUnit: "kg", loadEntry: "total", ...over });
    expect(bad(-1)).toThrow(LoadIntegrityError);
    expect(bad(NaN)).toThrow(LoadIntegrityError);
    expect(bad(Infinity)).toThrow(LoadIntegrityError);
    expect(bad(0.0004)).toThrow(/too small/);
    expect(bad(10000)).toThrow(/more than a load can hold/);
    expect(bad(600, { maxTotalKg: 500 })).toThrow(LoadIntegrityError);
    expect(() => buildSetLoad({ typedValue: 5, typedUnit: "stone" as never, loadEntry: "total" }))
      .toThrow(LoadIntegrityError);
  });

  it("property: every built load is accepted by the mirror and shows back exactly as typed", () => {
    for (let i = 0; i < 20000; i++) {
      const unit = rand() < 0.5 ? "kg" : "lb";
      const loadEntry = rand() < 0.5 ? "total" : "per_side";
      const typedValue = dp(rand() * 600, Math.floor(rand() * 4));
      let built;
      try {
        built = buildSetLoad({ typedValue, typedUnit: unit, loadEntry });
      } catch (e) {
        expect(e).toBeInstanceOf(LoadIntegrityError);
        continue;
      }
      expect(isAcceptedAuthoredLoad(built).ok).toBe(true);
      if (built.entered_load !== null) {
        // what the lifter typed is what any surface shows back, same unit
        expect(shownLoadValue(built, unit)).toBe(dp(typedValue, 3));
      }
    }
  });
});

describe("isAcceptedAuthoredLoad (mirror of validate_entered_load_consistency)", () => {
  const ok = { load_kg: 102.06, load_entry: "total", entered_load: 225, entered_unit: "lb" };
  it("accepts consistent and legacy rows", () => {
    expect(isAcceptedAuthoredLoad(ok).ok).toBe(true);
    expect(isAcceptedAuthoredLoad({ load_kg: 61.2345 }).ok).toBe(true);
    expect(isAcceptedAuthoredLoad({ load_kg: 0 }).ok).toBe(true);
    expect(isAcceptedAuthoredLoad({ load_kg: null, load_entry: null }, "prescriptions").ok).toBe(true);
  });
  it("refuses each way the production rows disagreed", () => {
    const code = (row: object, table: "sets" | "prescriptions" = "sets") => {
      const v = isAcceptedAuthoredLoad(row, table);
      return v.ok ? "ok" : v.code;
    };
    expect(code({ ...ok, load_kg: 100 })).toBe("mismatch"); // stale total
    expect(code({ ...ok, entered_load: 220.5, load_kg: 100 })).toBe("mismatch");
    expect(code({ ...ok, load_entry: "per_side" })).toBe("mismatch"); // toggle flipped
    expect(code({ ...ok, entered_unit: "kg" })).toBe("mismatch");
    expect(code({ ...ok, entered_unit: null })).toBe("pair");
    expect(code({ ...ok, entered_load: null })).toBe("pair");
    expect(code({ ...ok, load_entry: null })).toBe("entry_required");
    expect(code({ load_kg: 0, load_entry: "per_side" })).toBe("per_side_zero");
    expect(code({ load_kg: 0 }, "prescriptions")).toBe("load_range");
    expect(code({ ...ok, load_pct_tm: 80 }, "prescriptions")).toBe("pct");
    expect(code({ load_kg: 10000 })).toBe("overflow");
  });
  it("assertAcceptedAuthoredLoad throws a lifter-readable LoadIntegrityError", () => {
    expect(() => assertAcceptedAuthoredLoad({ ...ok, load_kg: 100 })).toThrow(/was not saved/);
  });
});

describe("provenanceForTotal", () => {
  it("claims a typed number only when it reproduces the total", () => {
    expect(provenanceForTotal(102.06, "lb", "total")).toEqual({ entered_load: 225, entered_unit: "lb" });
    expect(provenanceForTotal(100, "lb", "total")).toEqual({ entered_load: null, entered_unit: null });
    expect(provenanceForTotal(22.5, "kg", "per_side")).toEqual({ entered_load: 11.25, entered_unit: "kg" });
    expect(provenanceForTotal(0, "kg", "total")).toEqual({ entered_load: null, entered_unit: null });
  });
});

describe("display round trip", () => {
  it("a draft's typed number is what the stepper shows and what is saved", () => {
    for (let i = 0; i < 5000; i++) {
      const unit = rand() < 0.5 ? "kg" : "lb";
      const entryKg = dp(rand() * 300, 2);
      const typed = typedFromDraft({ entryKg }, unit);
      expect(typed.unit).toBe(unit);
      expect(typed.value).toBe(stagedDisplayLoad(entryKg, undefined, undefined, unit));
      expect(typed.value).toBe(toDisplay(entryKg, unit));
    }
  });

  it("switching the display unit any number of times never changes what was typed", () => {
    for (let i = 0; i < 2000; i++) {
      const authoredUnit = rand() < 0.5 ? "kg" : "lb";
      const value = dp(rand() * 400 + 1, Math.floor(rand() * 3));
      const draft = { entryKg: dp(authoredUnit === "kg" ? value : value * 0.45359237, 2), enteredLoad: value, enteredUnit: authoredUnit as "kg" | "lb" };
      let unit: "kg" | "lb" = authoredUnit as "kg" | "lb";
      for (let k = 0; k < 7; k++) {
        unit = unit === "kg" ? "lb" : "kg";
        expect(typedFromDraft(draft, unit)).toEqual({ value, unit: authoredUnit });
      }
      // back in the authored unit the stepper shows the typed value exactly
      expect(stagedDisplayLoad(draft.entryKg, draft.enteredLoad, draft.enteredUnit, authoredUnit as "kg" | "lb")).toBe(value);
    }
  });

  it("a stored load viewed in the other unit is stable: re-reading the stored row never drifts", () => {
    for (let i = 0; i < 5000; i++) {
      const unit = rand() < 0.5 ? "kg" : "lb";
      const other = unit === "kg" ? "lb" : "kg";
      let built;
      try {
        built = buildSetLoad({ typedValue: dp(rand() * 500 + 0.5, 1), typedUnit: unit, loadEntry: rand() < 0.5 ? "total" : "per_side" });
      } catch { continue; }
      const first = shownLoadValue(built, other);
      for (let k = 0; k < 5; k++) expect(shownLoadValue(built, other)).toBe(first);
      // 225 lb is 102.06 kg and reads back as 225, never 224.9
      expect(shownLoadValue(built, unit)).toBe(built.entered_load);
      // converting what was typed 1-decimal lb -> kg -> lb returns it
      if (unit === "lb" && built.load_entry === "total") {
        expect(dp(built.load_kg / 0.45359237, 1)).toBe(dp(built.entered_load!, 1));
      }
    }
  });

  it("the 225 lb / 102.06 kg / 44.1 lb cases", () => {
    const b = buildSetLoad({ typedValue: 225, typedUnit: "lb", loadEntry: "total" });
    expect(shownLoadValue(b, "lb")).toBe(225);
    expect(shownLoadValue(b, "kg")).toBe(102.1);
    const k = buildSetLoad({ typedValue: 20, typedUnit: "kg", loadEntry: "total" });
    expect(shownLoadValue(k, "kg")).toBe(20);
    expect(shownLoadValue(k, "lb")).toBe(44.1);
    // legacy rows without provenance fall back to the conversion
    expect(shownLoadValue({ load_kg: 102.06 }, "lb")).toBe(225);
    expect(shownLoadValue({ load_kg: 60, load_entry: "per_side" }, "kg")).toBe(30);
  });
});

describe("structural guard", () => {
  // The bug class was a writer deriving load_kg and entered_load separately.
  // These are the helpers that did it; they no longer exist, and a new
  // writer must go through buildSetLoad (lib/setLoad.ts).
  const forbidden = [/\bloadToKg\s*\(/, /\bkgToEnteredLoad\s*\(/, /\bloadEntryForSet\s*\(/];
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === "node_modules" ? [] : walk(p);
      return /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [p] : [];
    });
  }
  it("no source file reintroduces a separate kg/typed derivation", () => {
    const hits = walk(join(__dirname, "..")).filter((f) => {
      const src = readFileSync(f, "utf8");
      return forbidden.some((re) => re.test(src));
    });
    expect(hits).toEqual([]);
  });
});
