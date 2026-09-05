// Small shared display formatters (Today, Session, End, History, charts).

import type { ResolvedPrescriptionRow } from "./types";
import { kgToLb, toDisplay, type Unit } from "./units";

/**
 * What to call a planned day.
 *
 * `label` is nullable AND can be blank: a day created in the app starts
 * unnamed, and `label ?? fallback` does not fire for an empty string, which
 * rendered a day with no heading at all. Blank and null are the same thing to
 * a reader, so they resolve the same way here rather than at four call sites.
 */
export function workoutName(w: {
  label: string | null;
  day_index: number;
}): string {
  const named = (w.label ?? "").trim();
  return named.length > 0 ? named : `Workout ${w.day_index + 1}`;
}

/** "5" or "5-8" */
export function formatRepRange(min: number, max: number): string {
  return min === max ? String(min) : `${min}-${max}`;
}

/** %TM prescription with no TM row to resolve against — must be surfaced. */
export function rxHasNoTm(rx: ResolvedPrescriptionRow): boolean {
  return rx.load_pct_tm !== null && rx.resolved_load_kg === null;
}

/** Preferred display/prefill load for a prescription (plate-rounded first). */
export function rxLoadKg(rx: ResolvedPrescriptionRow): number | null {
  return rx.plate_load_kg ?? rx.resolved_load_kg;
}

/**
 * THE prescription-target formatter. Every screen that renders a target
 * (Today's day preview, the session accordion, the plan editor) must use
 * this one — three hand-rolled variants had drifted apart (`×`/`@` vs
 * `×`/`·`) and read as three different apps.
 *
 * "3×5", "3×5 @ 115 lb", "3×5 @ 30 lb/side", or "3×5 @ 80% TM" when only a
 * percentage of an (unset) training max is known — that last case pairs with
 * `rxHasNoTm`.
 *
 * A per-side prescription is quoted PER SIDE, which is the number the coach
 * wrote and the number on the dumbbell. `load_kg` is always the TOTAL, so
 * rendering it raw showed a pair of 30s as "60 kg" on Today and on the session
 * target line — while the stepper directly beneath showed 30, and History's
 * own formatter showed 30/side. Three surfaces, two answers, and the wrong one
 * is a plausible instruction to pick up double.
 *
 * A WARMUP bracket says so: "1×12 @ 10 kg warmup · 3×8 @ 20 kg". The column
 * has existed since August and nothing rendered it, so a coach's warmup and
 * their first working set looked like the same instruction twice at two
 * different weights — and the target read as four sets of work when three
 * were asked for. An absent set_type is 'working' and stays unmarked, which
 * is every row written before the column existed. `backoff` is unmarked too:
 * it is work, and the app no longer offers it.
 */
export function formatRxTarget(
  rx: ResolvedPrescriptionRow,
  unit: Unit,
): string {
  const base = `${rx.sets}×${formatRepRange(rx.reps_min, rx.reps_max)}`;
  const tail = rx.set_type === "warmup" ? " warmup" : "";
  const load = rxLoadKg(rx);
  if (load !== null) {
    return rx.load_entry === "per_side"
      ? `${base} @ ${toDisplay(load / 2, unit)} ${unit}/side${tail}`
      : `${base} @ ${toDisplay(load, unit)} ${unit}${tail}`;
  }
  if (rx.load_pct_tm !== null) return `${base} @ ${rx.load_pct_tm}% TM${tail}`;
  return `${base}${tail}`;
}

/**
 * A plate or bar weight, as it is LABELLED on the iron.
 *
 * `toDisplay` rounds to one decimal, which is correct for a LOAD (a 102.06 kg
 * total is "102.1 kg") and wrong for a plate: the standard 1.25 kg plate —
 * one of the kg defaults in settings.ts — renders as "1.3", and no rack has a
 * 1.3. The lifter is matching this string against a number stamped on metal,
 * so a plate gets two decimals with trailing zeros trimmed: "1.25", "2.5",
 * "20", and "20.41" for a 45 lb plate read in kg mode.
 *
 * Loads keep `toDisplay`. Only the things you physically pick up use this.
 */
export function formatPlate(kg: number, unit: Unit): string {
  const v = unit === "kg" ? kg : kgToLb(kg);
  return String(Math.round(v * 100) / 100);
}

/**
 * The subtext under a load field: the SAME number in the other convention.
 *
 * kg is what the database stores everywhere, so when the user is typing lb
 * the twin states the stored value ("102.1 kg stored") — that string is the
 * app's only statement of the storage contract, and three screens must not
 * be able to word it differently. In kg it is just the lb equivalent.
 */
export function formatStoredTwin(kg: number, unit: Unit): string {
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return unit === "lb" ? `${round1(kg)} kg stored` : `${round1(kgToLb(kg))} lb`;
}

/** "2:30" — clocks and rest figures. */
export function formatClock(totalSeconds: number): string {
  const t = Math.abs(Math.round(totalSeconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** Date-only strings ("2026-08-24", e.g. v_weekly_volume.week_start or
 *  planned_workouts.scheduled_date) are parsed by `new Date()` as UTC
 *  midnight, which renders a day early anywhere west of Greenwich. Every
 *  formatter below routes through here so a bare date always means the
 *  device's local calendar day. Full timestamps keep native parsing. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toDate(d: string | Date): Date {
  if (typeof d !== "string") return d;
  return DATE_ONLY.test(d) ? parseLocalDate(d) : new Date(d);
}

/** "8/25" — compact axis fallback. */
export function formatShortDate(d: string | Date): string {
  const dd = toDate(d);
  return `${dd.getMonth() + 1}/${dd.getDate()}`;
}

/** "MON 24 AUG" — session group headers. */
export function formatSessionDate(d: string | Date): string {
  return toDate(d)
    .toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .replace(",", "")
    .toUpperCase();
}

/** "TODAY · TUESDAY 25 AUGUST" — Today screen heading. */
export function formatTodayHeading(d: Date = new Date()): string {
  const s = d
    .toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
    })
    .replace(",", "")
    .toUpperCase();
  return `TODAY · ${s}`;
}

/** Today's calendar date in the device's local timezone, as YYYY-MM-DD.
 *  Matches planned_workouts.scheduled_date for the start-gating comparison. */
export function todayLocalIso(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse a date-only string as LOCAL midnight (new Date('YYYY-MM-DD') would
 *  parse as UTC and shift the weekday for US evenings). */
export function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** "WED 27 AUG" — scheduled-day labels on the week list. */
export function formatPlannedDate(iso: string): string {
  return parseLocalDate(iso)
    .toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
    })
    .replace(",", "")
    .toUpperCase();
}

/** Mon–Sun ISO dates (YYYY-MM-DD, local) for the week containing d. */
export function getWeekDates(
  d: Date = new Date(),
  /** 0 = Sunday … 6 = Saturday. Was hardcoded to Monday, which is why the
   *  weekStartsOn setting had never moved anything. */
  weekStart = 1,
): string[] {
  const day = d.getDay(); // 0=Sun..6=Sat
  const offset = -(((day - weekStart) % 7) + 7) % 7;
  const first = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  return Array.from({ length: 7 }, (_, i) =>
    todayLocalIso(
      new Date(first.getFullYear(), first.getMonth(), first.getDate() + i),
    ),
  );
}

/** "M" / "T" / "W" — narrow weekday letter for the week strip. */
export function formatWeekdayLetter(iso: string): string {
  return parseLocalDate(iso)
    .toLocaleDateString("en-GB", { weekday: "narrow" })
    .toUpperCase();
}

/** "JUN" — month tick labels under the e1RM chart. */
export function formatMonth(d: string | Date): string {
  return toDate(d)
    .toLocaleDateString("en-GB", { month: "short" })
    .toUpperCase();
}
