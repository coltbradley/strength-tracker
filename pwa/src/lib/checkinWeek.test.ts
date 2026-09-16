import { describe, expect, it } from "vitest";
import {
  BUCKETS,
  buildGrid,
  dayCounts,
  defaultDayIndex,
  energyShade,
  formatMean,
} from "./checkinWeek";
import type { BucketRow } from "./checkinHistory";

const MON = "2026-09-07";

const row = (over: Partial<BucketRow>): BucketRow => ({
  local_date: MON,
  bucket: "morning",
  checkins: 1,
  energy_n: 1,
  energy_mean: 3,
  ...over,
});

describe("buildGrid", () => {
  it("is three buckets by seven days, morning first", () => {
    const g = buildGrid([], MON);
    expect(BUCKETS.map((b) => b.value)).toEqual([
      "morning",
      "midday",
      "evening",
    ]);
    expect(g).toHaveLength(3);
    expect(g.every((r) => r.length === 7)).toBe(true);
    expect(g[0][0]).toEqual({ kind: "empty" });
  });

  it("places energy, and a bucket with check-ins but no energy", () => {
    const g = buildGrid(
      [
        row({
          local_date: "2026-09-09",
          bucket: "evening",
          checkins: 2,
          energy_n: 2,
          energy_mean: 3.5,
        }),
        row({
          local_date: "2026-09-07",
          bucket: "midday",
          checkins: 1,
          energy_n: 0,
          energy_mean: null,
        }),
      ],
      MON,
    );
    expect(g[2][2]).toMatchObject({ kind: "energy", label: "3.5", n: 2 });
    expect(g[1][0]).toEqual({ kind: "noEnergy", n: 1 });
  });

  it("ignores rows outside the week", () => {
    const g = buildGrid([row({ local_date: "2026-09-14" })], MON);
    expect(g.flat().every((c) => c.kind === "empty")).toBe(true);
  });
});

describe("formatMean", () => {
  it("drops a trailing .0 and keeps one decimal otherwise", () => {
    expect(formatMean(4)).toBe("4");
    expect(formatMean(3.5)).toBe("3.5");
    expect(formatMean(2.67)).toBe("2.7");
    expect(formatMean(3.96)).toBe("4");
  });
});

describe("energyShade", () => {
  it("scales from faint at 1 to strong at 5 and flips text past the midpoint", () => {
    expect(energyShade(1)).toEqual({ percent: 10, inverse: false });
    expect(energyShade(5)).toEqual({ percent: 95, inverse: true });
    expect(energyShade(3).inverse).toBe(false);
    expect(energyShade(4).inverse).toBe(true);
  });
});

describe("dayCounts and defaultDayIndex", () => {
  it("counts check-ins per local day", () => {
    const at = (d: number, h: number) => new Date(2026, 8, d, h).toISOString();
    const local = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    expect(
      dayCounts(
        [
          { recorded_at: at(7, 8) },
          { recorded_at: at(7, 20) },
          { recorded_at: at(13, 9) },
        ],
        MON,
        local,
      ),
    ).toEqual([2, 0, 0, 0, 0, 0, 1]);
  });

  it("selects today in the current week and Monday otherwise", () => {
    expect(defaultDayIndex(MON, "2026-09-10")).toBe(3);
    expect(defaultDayIndex(MON, "2026-09-20")).toBe(0);
  });
});
