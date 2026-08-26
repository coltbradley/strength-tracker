// Small shared display formatters (Today, Session, End, History, charts).

import type { ResolvedPrescriptionRow } from "./types";
import { toDisplay, type Unit } from "./units";

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

/** "5 × 5 · 115 lb" (load part omitted when unresolvable). */
export function formatRxTarget(
  rx: ResolvedPrescriptionRow,
  unit: Unit,
): string {
  const load = rxLoadKg(rx);
  const base = `${rx.sets} × ${formatRepRange(rx.reps_min, rx.reps_max)}`;
  return load !== null ? `${base} · ${toDisplay(load, unit)} ${unit}` : base;
}

/** "2:30" — clocks and rest figures. */
export function formatClock(totalSeconds: number): string {
  const t = Math.abs(Math.round(totalSeconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** "8/25" — compact axis fallback. */
export function formatShortDate(d: string | Date): string {
  const dd = typeof d === "string" ? new Date(d) : d;
  return `${dd.getMonth() + 1}/${dd.getDate()}`;
}

/** "MON 24 AUG" — session group headers. */
export function formatSessionDate(d: string | Date): string {
  const dd = typeof d === "string" ? new Date(d) : d;
  return dd
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

/** "JUN" — month tick labels under the e1RM chart. */
export function formatMonth(d: string | Date): string {
  const dd = typeof d === "string" ? new Date(d) : d;
  return dd.toLocaleDateString("en-GB", { month: "short" }).toUpperCase();
}
