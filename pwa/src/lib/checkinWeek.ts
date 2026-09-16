// The History check-in grid, as data.
//
// Mornings compared with mornings: energy has a daily rhythm, so each cell is
// one fixed clock bucket on one day, never a whole-day average. Every cell
// that shows a mean also shows how many check-ins it rests on.
import { addDaysIso, type BucketRow } from "./checkinHistory";

export const BUCKETS: readonly { value: BucketRow["bucket"]; label: string }[] =
  [
    { value: "morning", label: "Morning" },
    { value: "midday", label: "Midday" },
    { value: "evening", label: "Evening" },
  ];

export type Cell =
  | { kind: "empty" }
  | { kind: "noEnergy"; n: number }
  | {
      kind: "energy";
      mean: number;
      label: string;
      n: number;
      percent: number;
      inverse: boolean;
    };

export function formatMean(mean: number): string {
  const r = Math.round(mean * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** How strongly to fill a cell: 10% of the accent at 1, 95% at 5. Text
 *  switches to the inverse colour once the fill is past half, so it stays
 *  readable on both ends. */
export function energyShade(mean: number): {
  percent: number;
  inverse: boolean;
} {
  const percent = Math.round(10 + ((mean - 1) / 4) * 85);
  return { percent, inverse: percent > 55 };
}

/** [bucket][day]: BUCKETS order, Monday first. */
export function buildGrid(
  rows: readonly BucketRow[],
  weekStart: string,
): Cell[][] {
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i));
  return BUCKETS.map((b) =>
    days.map((day): Cell => {
      const r = rows.find((x) => x.local_date === day && x.bucket === b.value);
      if (!r || r.checkins === 0) return { kind: "empty" };
      if (r.energy_n === 0 || r.energy_mean === null)
        return { kind: "noEnergy", n: r.checkins };
      return {
        kind: "energy",
        mean: r.energy_mean,
        label: formatMean(r.energy_mean),
        n: r.checkins,
        ...energyShade(r.energy_mean),
      };
    }),
  );
}

export function dayCounts(
  checkins: readonly { recorded_at: string }[],
  weekStart: string,
  localDateOf: (iso: string) => string,
): number[] {
  const days = Array.from({ length: 7 }, (_, i) => addDaysIso(weekStart, i));
  return days.map(
    (d) => checkins.filter((c) => localDateOf(c.recorded_at) === d).length,
  );
}

export function defaultDayIndex(weekStart: string, today: string): number {
  for (let i = 0; i < 7; i++) if (addDaysIso(weekStart, i) === today) return i;
  return 0;
}
