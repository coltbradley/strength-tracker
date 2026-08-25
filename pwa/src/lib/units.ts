// kg is the storage unit everywhere. lb exists only at the display edge.

export type Unit = "kg" | "lb";

export const KG_PER_LB = 0.45359237;

// Plate rounding increment in kg. Mirror of the SQL:
// v_resolved_prescriptions.plate_load_kg rounds to the nearest 2.5 kg in
// supabase/migrations/20260825120003_views.sql — keep the two in sync.
export const PLATE_KG = 2.5;
const PLATE_LB = 5;

export function kgToLb(kg: number): number {
  return kg / KG_PER_LB;
}

export function lbToKg(lb: number): number {
  return lb * KG_PER_LB;
}

/** kg -> value in the display unit, rounded to 1 decimal. */
export function toDisplay(kg: number, unit: Unit): number {
  const v = unit === "kg" ? kg : kgToLb(kg);
  return Math.round(v * 10) / 10;
}

/** value entered/shown in the display unit -> kg (unrounded). */
export function fromDisplay(value: number, unit: Unit): number {
  return unit === "kg" ? value : lbToKg(value);
}

/**
 * Round a kg load to the nearest achievable plate load in the display unit:
 * nearest 2.5 kg in kg mode, nearest 5 lb in lb mode (result still in kg).
 */
export function roundToPlate(kg: number, unit: Unit): number {
  if (unit === "kg") return Math.round(kg / PLATE_KG) * PLATE_KG;
  const lb = Math.round(kgToLb(kg) / PLATE_LB) * PLATE_LB;
  return lbToKg(lb);
}

/** Stepper increments, expressed in kg, for the active display unit. */
export function stepKg(unit: Unit, fine: boolean): number {
  if (unit === "kg") return fine ? 0.5 : PLATE_KG;
  return fine ? lbToKg(1) : lbToKg(PLATE_LB);
}

export function formatLoad(kg: number, unit: Unit): string {
  return `${toDisplay(kg, unit)} ${unit}`;
}
