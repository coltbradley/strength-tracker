// Small shared display formatters (Today, Session, charts).

import type { ResolvedPrescriptionRow } from "./types";
import { formatLoad, type Unit } from "./units";

/** "3" or "3–5" */
export function formatRepRange(min: number, max: number): string {
  return min === max ? String(min) : `${min}–${max}`;
}

/** %TM prescription with no TM row to resolve against — must be surfaced. */
export function rxHasNoTm(rx: ResolvedPrescriptionRow): boolean {
  return rx.load_pct_tm !== null && rx.resolved_load_kg === null;
}

/** Preferred display/prefill load for a prescription (plate-rounded first). */
export function rxLoadKg(rx: ResolvedPrescriptionRow): number | null {
  return rx.plate_load_kg ?? rx.resolved_load_kg;
}

/** "3×3–5 @ 100 kg" (load part omitted when unresolvable). */
export function formatRxTarget(
  rx: ResolvedPrescriptionRow,
  unit: Unit,
): string {
  const load = rxLoadKg(rx);
  const base = `${rx.sets}×${formatRepRange(rx.reps_min, rx.reps_max)}`;
  return load !== null ? `${base} @ ${formatLoad(load, unit)}` : base;
}

/** "8/25" — axis labels on the two charts. */
export function formatShortDate(d: string | Date): string {
  const dd = typeof d === "string" ? new Date(d) : d;
  return `${dd.getMonth() + 1}/${dd.getDate()}`;
}
