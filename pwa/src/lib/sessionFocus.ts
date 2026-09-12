import {
  targetSets,
  type ExerciseEntry,
} from "./entries";

export type SessionPresentation = "focus" | "overview";

/** A correction's controls must stay with the entry whose set is being fixed. */
export function pinnedOverviewEntryKey(
  requestedKey: string | null,
  correctedEntryKey: string | null,
): string | null {
  return correctedEntryKey ?? requestedKey;
}

/** Pick the active unfinished entry, or the first unfinished entry. */
export function focusEntryKey(
  entries: readonly ExerciseEntry[],
  isDone: (entry: ExerciseEntry) => boolean,
  restoredKey: string | null,
): string | null {
  if (restoredKey !== null) {
    const restored = entries.find((entry) => entry.key === restoredKey);
    if (restored && !isDone(restored)) return restored.key;
  }
  return entries.find((entry) => !isDone(entry))?.key ?? null;
}

/** Progress shown by focus mode, derived from the canonical exercise entries. */
export function remainingProgress(
  entries: readonly ExerciseEntry[],
  isDone: (entry: ExerciseEntry) => boolean,
): { setsRemaining: number; exercisesRemaining: number } {
  const remaining = entries.filter((entry) => !isDone(entry));
  return {
    setsRemaining: remaining.reduce((total, entry) => total + targetSets(entry), 0),
    exercisesRemaining: remaining.length,
  };
}

/** Timed prescriptions use a different logging surface, so can't use focus mode. */
export function isFocusEligible(entries: readonly ExerciseEntry[]): boolean {
  return entries.every((entry) =>
    entry.brackets.every((bracket) => bracket.tracking !== "time"),
  );
}

export function transitionPresentation(
  current: SessionPresentation,
  next: SessionPresentation,
  overviewSelection: string | null,
  priorFocusKey: string | null,
): { presentation: SessionPresentation; focusKey: string | null } {
  if (current === "overview" && next === "focus") {
    return { presentation: "focus", focusKey: overviewSelection ?? priorFocusKey };
  }
  return { presentation: next, focusKey: priorFocusKey };
}
