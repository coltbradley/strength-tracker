// Month-grid maths for the calendar sheet, and the week-start rule the Today
// strip shares with it.
//
// All of this is pure and local-time: dates in this app are ISO day strings
// ("2026-08-31") in the DEVICE's timezone, because the phone travels with the
// lifter (CLAUDE.md). Nothing here touches UTC, and nothing constructs a Date
// from an ISO string without going through parseLocalDate — `new Date("...")`
// parses a bare date as UTC and lands on the wrong day west of Greenwich.

import { parseLocalDate, todayLocalIso } from "./format";

/** 0 = Sunday … 6 = Saturday, matching Date.getDay(). */
export type WeekStart = number;

/** The ISO day `n` days after `iso`. Negative goes back. */
export function addDays(iso: string, n: number): string {
  const d = parseLocalDate(iso);
  return todayLocalIso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/**
 * The first day of the week containing `iso`, honouring the configured start.
 *
 * The old getWeekDates hardcoded Monday and took no argument, so the
 * weekStartsOn setting had never actually moved anything — it was a control
 * wired to nothing.
 */
export function startOfWeek(iso: string, weekStart: WeekStart): string {
  const day = parseLocalDate(iso).getDay();
  // ((day - start) + 7) % 7 is how far INTO the week we are, for any start.
  return addDays(iso, -(((day - weekStart) % 7) + 7) % 7);
}

/** The seven ISO days of the week containing `iso`, in display order. */
export function weekDates(iso: string, weekStart: WeekStart): string[] {
  const first = startOfWeek(iso, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

export interface MonthCell {
  iso: string;
  /** false for the leading/trailing days that pad the grid to whole weeks */
  inMonth: boolean;
}

/**
 * A month as whole weeks, padded at both ends so every row has seven cells.
 *
 * Returns 5 or 6 rows depending on the month, never a fixed 6: a fixed grid
 * leaves a trailing empty week that reads as part of the month.
 */
export function monthGrid(
  year: number,
  month: number, // 0-11, as Date uses
  weekStart: WeekStart,
): MonthCell[][] {
  const firstIso = todayLocalIso(new Date(year, month, 1));
  const lastIso = todayLocalIso(new Date(year, month + 1, 0));
  const gridStart = startOfWeek(firstIso, weekStart);
  const gridEnd = addDays(startOfWeek(lastIso, weekStart), 6);

  const rows: MonthCell[][] = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    rows.push(
      Array.from({ length: 7 }, (_, i) => {
        const iso = addDays(cursor, i);
        return { iso, inMonth: parseLocalDate(iso).getMonth() === month };
      }),
    );
    cursor = addDays(cursor, 7);
  }
  return rows;
}

/** Weekday initials in display order, for the grid header. */
export function weekdayLetters(weekStart: WeekStart): string[] {
  // Any known Sunday works as the anchor; 2024-01-07 was one.
  return Array.from({ length: 7 }, (_, i) =>
    parseLocalDate(addDays("2024-01-07", (weekStart + i) % 7))
      .toLocaleDateString("en-GB", { weekday: "narrow" })
      .toUpperCase(),
  );
}

/** Month and year for a heading: "August 2026". */
export function monthLabel(year: number, month: number): string {
  return new Date(year, month, 1).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}
