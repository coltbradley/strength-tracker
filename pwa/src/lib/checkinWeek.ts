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
    };

export function formatMean(mean: number): string {
  const r = Math.round(mean * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** How strongly to fill a cell: 10% of the accent at 1, up to
 *  MAX_ENERGY_FILL_PERCENT at 5. The cap (not 95, as an earlier version used)
 *  exists so cell text can stay --text (dark) at every energy level: at
 *  MAX_ENERGY_FILL_PERCENT the composited fill (--accent over --paper) still
 *  clears 4.5:1 (WCAG AA) against --text, verified for every 0.1 step from
 *  1.0-5.0 and against continuous mean values in
 *  checkinWeek.test.ts. Past that percent the fill gets dark enough that
 *  NEITHER --text nor --text-inverse clears 4.5:1 against it (see the
 *  contrast script referenced in docs/decisions.md / task-6-report.md), so
 *  there is no percent/text-colour combination above the cap that is both AA
 *  and readable — capping the fill is the only way to keep dark text legal
 *  at the top of the scale. The fill still strictly increases with energy
 *  across the whole 1-5 range (10 -> MAX_ENERGY_FILL_PERCENT), it just rises
 *  more gently than the old 10-95 range did. */
const MIN_ENERGY_FILL_PERCENT = 10;
const MAX_ENERGY_FILL_PERCENT = 57;

export function energyShade(mean: number): { percent: number } {
  const span = MAX_ENERGY_FILL_PERCENT - MIN_ENERGY_FILL_PERCENT;
  const percent = Math.round(MIN_ENERGY_FILL_PERCENT + ((mean - 1) / 4) * span);
  return { percent };
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
