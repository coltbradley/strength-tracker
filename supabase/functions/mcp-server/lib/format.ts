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
