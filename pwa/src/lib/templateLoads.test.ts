import { describe, expect, it } from "vitest";
import { refreshedLoads, type LoadRow } from "./templateLoads";

const row = (
  exercise_id: string,
  load_kg: number | null,
  extra: Partial<LoadRow> = {},
): LoadRow => ({
  exercise_id,
  load_kg,
  load_pct_tm: null,
  set_type: "working",
  ...extra,
});

describe("refreshedLoads", () => {
  it("moves a straight scheme to the last actual", () => {
    expect(refreshedLoads([row("squat", 100)], { squat: { load_kg: 110 } }))
      .toEqual([110]);
  });

  it("rescales a ramp instead of flattening it", () => {
    // The bug this exists to prevent: 60/85/112.5 all becoming 110.
    const out = refreshedLoads(
      [row("squat", 60), row("squat", 85), row("squat", 112.5)],
      { squat: { load_kg: 110 } },
    );
    expect(out).toEqual([58.5, 83, 110]);
    // shape preserved: still strictly increasing
    expect(out[0]!).toBeLessThan(out[1]!);
    expect(out[1]!).toBeLessThan(out[2]!);
  });

  it("lands the top set exactly on the weight that was lifted", () => {
    const out = refreshedLoads(
      [row("bench", 60), row("bench", 102.5)],
      { bench: { load_kg: 97.5 } },
    );
    expect(out[1]).toBe(97.5);
  });

  it("leaves a %TM row alone", () => {
    const out = refreshedLoads(
      [row("press", null, { load_pct_tm: 70 })],
      { press: { load_kg: 60 } },
    );
    expect(out).toEqual([null]);
  });

  it("keeps a %TM row out of the scale of the ramp around it", () => {
    const out = refreshedLoads(
      [row("squat", 60), row("squat", null, { load_pct_tm: 80 }), row("squat", 100)],
      { squat: { load_kg: 120 } },
    );
    expect(out[1]).toBeNull();
    expect(out[2]).toBe(120); // top of the ABSOLUTE rows
    expect(out[0]).toBe(72); // 60 * (120/100)
  });

  it("leaves a bodyweight row alone", () => {
    expect(refreshedLoads([row("chin", null)], { chin: { load_kg: 0 } }))
      .toEqual([null]);
  });

  it("keeps the saved numbers when the exercise has never been logged", () => {
    const out = refreshedLoads(
      [row("squat", 60), row("squat", 100)],
      { bench: { load_kg: 80 } },
    );
    expect(out).toEqual([null, null]);
  });

  it("treats non-consecutive rows for one exercise as separate ramps", () => {
    const out = refreshedLoads(
      [row("squat", 100), row("bench", 80), row("squat", 50)],
      { squat: { load_kg: 120 }, bench: { load_kg: 90 } },
    );
    // each squat run scales against its own top, so both land on 120
    expect(out).toEqual([120, 90, 120]);
  });

  it("rounds to the half kilo and never invents precision", () => {
    const out = refreshedLoads(
      [row("squat", 61), row("squat", 100)],
      { squat: { load_kg: 103 } },
    );
    expect(out[0]! * 2).toBe(Math.round(out[0]! * 2));
  });

  it("an empty plan refreshes nothing", () => {
    expect(refreshedLoads([], { squat: { load_kg: 100 } })).toEqual([]);
  });
});
