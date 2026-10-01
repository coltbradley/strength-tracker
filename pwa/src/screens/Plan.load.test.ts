// The plan editor's load fields come from lib/setLoad.ts. Walk the edit that
// used to write a prescription the database refused: a kg-authored plan,
// edited with the lb steppers.
import { describe, expect, it } from "vitest";
import { isAcceptedAuthoredLoad } from "../lib/setLoad";
import { toDisplay } from "../lib/units";
import type { ResolvedPrescriptionRow } from "../lib/types";
import { draftFrom, patchFrom } from "./Plan";

function rx(over: Partial<ResolvedPrescriptionRow>): ResolvedPrescriptionRow {
  return {
    id: "r1",
    exercise_id: "Barbell_Squat",
    exercise_name: "Barbell Squat",
    position: 0,
    sets: 3,
    reps_min: 5,
    reps_max: 5,
    load_kg: 100,
    load_pct_tm: null,
    resolved_load_kg: 100,
    plate_load_kg: null,
    rest_seconds: 180,
    notes: null,
    superset_group: null,
    section: null,
    tracking: "reps",
    set_type: "working",
    load_entry: "total",
    entered_load: 100,
    entered_unit: "kg",
    ...over,
  } as ResolvedPrescriptionRow;
}

describe("plan editor load fields", () => {
  it("a kg plan stepped in lb writes a consistent prescription", () => {
    const draft = draftFrom(rx({}), "barbell");
    // the lb stepper: kg working value moves by 5 lb, entered = display value
    const v = draft.load_kg + 5 * 0.45359237;
    const stepped = { ...draft, load_kg: v, entered_unit: "lb" as const, entered_load: toDisplay(v, "lb") };
    const patch = patchFrom(stepped);
    expect(patch.entered_load).toBe(stepped.entered_load);
    expect(isAcceptedAuthoredLoad(patch, "prescriptions")).toEqual({ ok: true });
  });

  it("1.25 kg steps per side are not rounded to one decimal beside an exact total", () => {
    const draft = { ...draftFrom(rx({ load_entry: "per_side" }), "dumbbell"), load_kg: 11.25, entered_unit: "kg" as const, entered_load: 11.25 };
    const patch = patchFrom(draft);
    expect(patch).toMatchObject({ load_kg: 22.5, load_entry: "per_side", entered_load: 11.25, entered_unit: "kg" });
    expect(isAcceptedAuthoredLoad(patch, "prescriptions").ok).toBe(true);
  });

  it("an untouched row is unchanged, and a load of zero is stored as no load", () => {
    const row = rx({ load_kg: 102.06, entered_load: 225, entered_unit: "lb" });
    const p = patchFrom(draftFrom(row, "barbell"));
    expect([p.load_kg, p.entered_load, p.entered_unit]).toEqual([102.06, 225, "lb"]);
    const zero = patchFrom({ ...draftFrom(row, "barbell"), load_kg: 0 });
    expect([zero.load_kg, zero.load_entry, zero.entered_load, zero.entered_unit]).toEqual([null, null, null, null]);
  });
});
