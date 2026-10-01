// Small display formatters shared by tool summaries.

/** "3 x 5" for a fixed rep count, "3 x 6-8" for a range. */
export function formatRepRange(
  sets: number,
  repsMin: number,
  repsMax: number,
): string {
  return repsMin === repsMax
    ? `${sets} x ${repsMin}`
    : `${sets} x ${repsMin}-${repsMax}`;
}

/**
 * A DERIVED weight (a halved total, a percentage of a training max) as text a
 * person reads: at most one decimal, no ".0", no float artefacts, except a
 * quarter-kg (the 1.25 kg plate) which is exact. A number somebody TYPED is
 * quoted as typed and never goes through here. Mirror of the PWA's
 * lib/displayLoad.ts rule for kg.
 */
export function humanKg(kg: number): string {
  const two = Math.round((Math.abs(kg) + 1e-9) * 100) / 100;
  const quarter = Math.abs(two * 4 - Math.round(two * 4)) < 1e-9;
  const v = quarter ? two : Math.round((Math.abs(kg) + 1e-9) * 10) / 10;
  return String(kg < 0 ? -v : v);
}
