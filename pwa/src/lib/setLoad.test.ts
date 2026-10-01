import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertAcceptedAuthoredLoad,
  buildSetLoad,
  isAcceptedAuthoredLoad,
  LoadIntegrityError,
  provenanceForTotal,
  repairAuthoredLoad,
  solveTypedLoad,
  shownLoadValue,
  typedFromDraft,
} from "./setLoad";
import { stagedDisplayLoad, toTypedDisplay, KG_PER_LB as KGLB } from "./units";
import { stepTo } from "../components/Stepper";

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
      expect(typed.value).toBe(toTypedDisplay(entryKg, unit));
    }
  });

  // F-2: a load stepped on the lifter's own grid keeps what the step says. The
  // stepper walks a kg total (stepTo rounds it to 2 decimals); the typed
  // number it implies, what buildSetLoad stores, and what is shown afterwards
  // must all be the same number.
  it("F-2: stepping the 1.25 kg and 2.5 lb grids stores and shows exactly the stepped number", () => {
    const grids = [
      { unit: "kg" as const, step: 1.25, deltaKg: 1.25 },
      { unit: "lb" as const, step: 2.5, deltaKg: 2.5 * KGLB },
    ];
    for (const g of grids) {
      for (const start of [0, 20, 22.5, 45, 62.5]) {
        let entryKg = start;
        for (let n = 1; n <= 240; n++) {
          entryKg = stepTo(entryKg, g.deltaKg, 0, 999, true);
          const typed = typedFromDraft({ entryKg }, g.unit);
          // the stepper face, the typed number and the stored pair agree
          expect(typed.value).toBe(toTypedDisplay(entryKg, g.unit));
          expect(stagedDisplayLoad(entryKg, undefined, undefined, g.unit)).toBe(typed.value);
          const built = buildSetLoad({ typedValue: typed.value, typedUnit: g.unit, loadEntry: "total" });
          expect(built.entered_load).toBe(typed.value);
          expect(built.entered_unit).toBe(g.unit);
          expect(shownLoadValue(built, g.unit)).toBe(typed.value);
          // and it is on the grid the lifter stepped, not a rounded neighbour
          if (g.unit === "kg") expect(typed.value % 1.25).toBeCloseTo(0, 9);
        }
      }
    }
    // the named cases
    expect(typedFromDraft({ entryKg: 21.25 }, "kg").value).toBe(21.25);
    expect(typedFromDraft({ entryKg: 64.75 }, "kg").value).toBe(64.75);
  });

  it("F-2/F-3: a typed 2-decimal load is stored and shown exactly as typed in either unit", () => {
    for (const [v, u] of [[21.25, "kg"], [22.25, "kg"], [62.25, "kg"], [225.25, "lb"], [102.5, "lb"]] as const) {
      const b = buildSetLoad({ typedValue: v, typedUnit: u, loadEntry: "total" });
      expect(b.entered_load).toBe(v);
      expect(shownLoadValue(b, u)).toBe(v);
      expect(stagedDisplayLoad(b.load_kg, b.entered_load!, b.entered_unit!, u)).toBe(v);
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

describe("solveTypedLoad: restore what the lifter typed", () => {
  const dead = (load_kg: number, entered_load: number, load_entry: "total" | "per_side" = "total") =>
    ({ load_kg, load_entry, entered_load, entered_unit: "kg" as const });

  it("solves the four incident totals as the pounds that were typed", () => {
    expect(solveTypedLoad(dead(65.77, 65.8))).toEqual({ entered_load: 145, entered_unit: "lb" });
    expect(solveTypedLoad(dead(34.02, 34))).toEqual({ entered_load: 75, entered_unit: "lb" });
    expect(solveTypedLoad(dead(45.36, 45.4))).toEqual({ entered_load: 100, entered_unit: "lb" });
    expect(solveTypedLoad(dead(52.16, 52.2))).toEqual({ entered_load: 115, entered_unit: "lb" });
  });

  it("solves per-side lb and picks kg when only kg reproduces the total", () => {
    expect(solveTypedLoad(dead(65.77, 65.8, "per_side"))).toEqual({ entered_load: 72.5, entered_unit: "lb" });
    expect(solveTypedLoad(dead(100, 99.9))).toEqual({ entered_load: 100, entered_unit: "kg" });
    expect(solveTypedLoad(dead(42.5, 21.3, "per_side"))).toEqual({ entered_load: 21.25, entered_unit: "kg" });
  });

  it("returns null when no grid value gives exactly that total (provenance unknown)", () => {
    expect(solveTypedLoad(dead(60.01, 60))).toBeNull();
    expect(solveTypedLoad(dead(0, 1))).toBeNull();
    expect(solveTypedLoad({ load_kg: 100, load_entry: null, entered_load: 1, entered_unit: "kg" })).toBeNull();
  });

  it("every solution is exactly what the trigger mirror accepts, over a lb and kg sweep", () => {
    for (let lb = 5; lb <= 700; lb += 0.5) {
      for (const entry of ["total", "per_side"] as const) {
        const built = buildSetLoad({ typedValue: lb, typedUnit: "lb", loadEntry: entry });
        const solved = solveTypedLoad({ ...built, entered_load: lb, entered_unit: "lb" });
        expect(solved).not.toBeNull();
        const row = { load_kg: built.load_kg, load_entry: entry, ...solved! };
        expect(isAcceptedAuthoredLoad(row)).toEqual({ ok: true });
      }
    }
    for (let kg = 1; kg <= 300; kg += 0.25) {
      const built = buildSetLoad({ typedValue: kg, typedUnit: "kg", loadEntry: "total" });
      const solved = solveTypedLoad({ ...built, entered_load: kg, entered_unit: "kg" });
      expect(solved).not.toBeNull();
      expect(isAcceptedAuthoredLoad({ load_kg: built.load_kg, load_entry: "total", ...solved! })).toEqual({ ok: true });
    }
  });

  it("tie rule: when both units reproduce the total, the recorded unit wins only if its number agrees", () => {
    // find a real coincidence of the two grids
    let found: { kg: number; lb: number; total: number } | null = null;
    for (let lb = 1; lb <= 400 && !found; lb += 0.5) {
      const total = buildSetLoad({ typedValue: lb, typedUnit: "lb", loadEntry: "total" }).load_kg;
      const kg = Math.round(total / 0.25) * 0.25;
      if (Math.abs(kg - total) < 1e-9) found = { kg, lb, total };
    }
    if (!found) return; // the grids never coincide in range: nothing to resolve
    const base = { load_kg: found.total, load_entry: "total" as const };
    expect(solveTypedLoad({ ...base, entered_load: found.lb, entered_unit: "lb" }))
      .toEqual({ entered_load: found.lb, entered_unit: "lb" });
    expect(solveTypedLoad({ ...base, entered_load: found.kg, entered_unit: "kg" }))
      .toEqual({ entered_load: found.kg, entered_unit: "kg" });
    expect(repairAuthoredLoad({ ...base, entered_load: found.kg, entered_unit: "kg" }).alternative)
      .toEqual({ entered_load: found.lb, entered_unit: "lb" });
    // a recorded number nowhere near either candidate is not evidence: ambiguous -> unknown
    expect(solveTypedLoad({ ...base, entered_load: 3, entered_unit: "kg" })).toBeNull();
  });

  it("repairAuthoredLoad changes only entered_load/entered_unit and reports what was saved", () => {
    const row = { id: "x", reps: 5, rpe: 8, load_kg: 65.77, load_entry: "total" as const, entered_load: 65.8, entered_unit: "kg" as const };
    const out = repairAuthoredLoad(row);
    expect(out.restored).toBe(true);
    expect(out.was).toEqual({ entered_load: 65.8, entered_unit: "kg" });
    expect(out.alternative).toBeNull();
    expect(out.row).toEqual({ ...row, entered_load: 145, entered_unit: "lb" });
    const unknown = repairAuthoredLoad({ ...row, load_kg: 60.01 });
    expect(unknown.restored).toBe(false);
    expect(unknown.row).toEqual({ ...row, load_kg: 60.01, entered_load: null, entered_unit: null });
  });
});
