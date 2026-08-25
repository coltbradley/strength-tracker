import { describe, expect, it } from "vitest";
import { epleyE1rm, qualifiesForE1rm } from "./e1rm";

describe("e1rm", () => {
  it("matches the SQL view formula round(load * (1 + reps/30), 1)", () => {
    // mirror v_e1rm: round(s.load_kg * (1 + s.reps / 30.0), 1)
    expect(epleyE1rm(100, 5)).toBe(116.7);
    expect(epleyE1rm(100, 1)).toBe(103.3);
    expect(epleyE1rm(60, 8)).toBe(76);
    expect(epleyE1rm(142.5, 3)).toBe(156.8);
    expect(epleyE1rm(100, 30)).toBe(200);
  });

  it("only working sets with 1-8 reps and load > 0 qualify", () => {
    expect(
      qualifiesForE1rm({ set_type: "working", reps: 5, load_kg: 100 }),
    ).toBe(true);
    expect(
      qualifiesForE1rm({ set_type: "working", reps: 1, load_kg: 100 }),
    ).toBe(true);
    expect(
      qualifiesForE1rm({ set_type: "working", reps: 8, load_kg: 100 }),
    ).toBe(true);
    // 9+ reps degrade the estimate
    expect(
      qualifiesForE1rm({ set_type: "working", reps: 9, load_kg: 100 }),
    ).toBe(false);
    expect(
      qualifiesForE1rm({ set_type: "working", reps: 0, load_kg: 100 }),
    ).toBe(false);
    // non-working sets are noise
    expect(
      qualifiesForE1rm({ set_type: "warmup", reps: 5, load_kg: 100 }),
    ).toBe(false);
    expect(
      qualifiesForE1rm({ set_type: "backoff", reps: 5, load_kg: 100 }),
    ).toBe(false);
    // bodyweight (0 load) never qualifies
    expect(qualifiesForE1rm({ set_type: "working", reps: 5, load_kg: 0 })).toBe(
      false,
    );
  });
});
