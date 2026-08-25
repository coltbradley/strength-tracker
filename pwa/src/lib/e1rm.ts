// Epley e1RM, mirroring the SQL view v_e1rm exactly:
//   round(load_kg * (1 + reps / 30.0), 1)
// Only working sets with 1-8 reps and load > 0 qualify (estimate degrades
// above 8 reps; warmups/backoffs are noise).

import type { SetType } from "./types";

export function epleyE1rm(loadKg: number, reps: number): number {
  return Math.round(loadKg * (1 + reps / 30) * 10) / 10;
}

export function qualifiesForE1rm(set: {
  set_type: SetType;
  reps: number;
  load_kg: number;
}): boolean {
  return (
    set.set_type === "working" &&
    set.reps >= 1 &&
    set.reps <= 8 &&
    set.load_kg > 0
  );
}
