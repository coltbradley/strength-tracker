import { describe, expect, it } from "vitest";
import { prefillSet } from "./prefill";

const rx = {
  resolved_load_kg: 100,
  plate_load_kg: 100,
  reps_min: 3,
  reps_max: 5,
};

describe("prefillSet fallback order", () => {
  it("uses prescription resolved load first", () => {
    const r = prefillSet({
      prescription: rx,
      lastThisSession: { load_kg: 90, reps: 4 },
      lastSession: { load_kg: 80, reps: 6 },
    });
    expect(r.loadKg).toBe(100);
    expect(r.reps).toBe(5); // top of prescribed range
  });

  it("prefers plate-rounded load over raw resolved load", () => {
    const r = prefillSet({
      prescription: { ...rx, resolved_load_kg: 101.3, plate_load_kg: 102.5 },
      lastThisSession: null,
      lastSession: null,
    });
    expect(r.loadKg).toBe(102.5);
  });

  it("falls back to last set this session when prescription has no load (no TM)", () => {
    const r = prefillSet({
      prescription: { ...rx, resolved_load_kg: null, plate_load_kg: null },
      lastThisSession: { load_kg: 90, reps: 4 },
      lastSession: { load_kg: 80, reps: 6 },
    });
    expect(r.loadKg).toBe(90);
    expect(r.reps).toBe(5); // reps still come from the prescription range
  });

  it("falls back to last session's actual when nothing logged this session", () => {
    const r = prefillSet({
      prescription: null,
      lastThisSession: null,
      lastSession: { load_kg: 80, reps: 6 },
    });
    expect(r.loadKg).toBe(80);
    expect(r.reps).toBe(6);
  });

  it("last-this-session beats last-session when there is no prescription", () => {
    const r = prefillSet({
      prescription: null,
      lastThisSession: { load_kg: 90, reps: 4 },
      lastSession: { load_kg: 80, reps: 6 },
    });
    expect(r.loadKg).toBe(90);
    expect(r.reps).toBe(4);
  });

  it("defaults to the empty bar when there is no signal at all", () => {
    const r = prefillSet({
      prescription: null,
      lastThisSession: null,
      lastSession: null,
    });
    expect(r.loadKg).toBe(20);
    expect(r.reps).toBe(8);
  });

  it("hands back what an earlier set was typed as, only when that set is the source", () => {
    const typed = { load_kg: 22.5, reps: 8, load_entry: "per_side" as const, entered_load: 11.25, entered_unit: "kg" as const };
    expect(prefillSet({ prescription: null, lastThisSession: null, lastSession: typed }).entered)
      .toEqual({ load: 11.25, unit: "kg", entry: "per_side" });
    // a prescription's load wins, and then nothing about the old set applies
    expect(prefillSet({
      prescription: { resolved_load_kg: 30, plate_load_kg: null, reps_min: 5, reps_max: 5 },
      lastThisSession: null,
      lastSession: typed,
    }).entered).toBeUndefined();
    // legacy set: no claim
    expect(prefillSet({ prescription: null, lastThisSession: null, lastSession: { load_kg: 60, reps: 5 } }).entered)
      .toBeUndefined();
  });
});
