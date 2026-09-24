import {
  targetSets,
  type ExerciseEntry,
} from "./entries";
import type { ProgressState } from "../components/session/StateGlyph";

export type SessionPresentation = "focus" | "overview";

/** All consecutive entries in the selected entry's superset group. */
export function supersetGroupEntries(
  entries: readonly ExerciseEntry[],
  key: string | null,
): readonly ExerciseEntry[] {
  if (key === null) return [];
  const index = entries.findIndex((entry) => entry.key === key);
  const group = entries[index]?.brackets[0]?.superset_group ?? null;
  if (index < 0 || group === null) return [];

  let start = index;
  let end = index;
  while (start > 0 && entries[start - 1].brackets[0]?.superset_group === group)
    start--;
  while (
    end < entries.length - 1 &&
    entries[end + 1].brackets[0]?.superset_group === group
  )
    end++;
  const run = entries.slice(start, end + 1);
  // A reused letter after a gap is malformed day structure, not a second
  // independent pair. Keep it out of paired Focus even when the local run
  // happens to contain exactly two exercises.
  const allMembers = entries.filter(
    (entry) => entry.brackets[0]?.superset_group === group,
  );
  return allMembers.length === run.length ? run : [];
}

/** Only a consecutive ordinary two-member run can use the paired round UI. */
export function twoMemberSuperset(
  entries: readonly ExerciseEntry[],
  key: string | null,
): readonly [ExerciseEntry, ExerciseEntry] | null {
  const members = supersetGroupEntries(entries, key);
  if (members.length !== 2) return null;
  const pair = [members[0], members[1]] as const;
  return pair.every(
    (entry) => (entry.brackets[0]?.tracking ?? "reps") === "reps",
  )
    ? pair
    : null;
}

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
  entryProgress: (entry: ExerciseEntry) => number = () => 0,
): { setsRemaining: number; exercisesRemaining: number } {
  const remaining = entries.filter((entry) => !isDone(entry));
  return {
    setsRemaining: remaining.reduce(
      (total, entry) =>
        total + Math.max(0, targetSets(entry) - entryProgress(entry)),
      0,
    ),
    exercisesRemaining: remaining.length,
  };
}

export function isFocusEligible(entries: readonly ExerciseEntry[]): boolean {
  if (entries.length === 0) return false;
  return !entries.some((entry) => supersetGroupEntries(entries, entry.key).length > 2);
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

/**
 * One entry's place in the shared state vocabulary (StateGlyph.tsx),
 * consumed by the progress rail, FocusSetProgress's caller and
 * WorkoutOverview alike, so the three surfaces can never describe the same
 * entry three different ways.
 *
 * Order matters: a skipped entry is never "done" even if `isDone` (which
 * folds skips in for its own purposes — see Session's `entryDone`) says so,
 * and "current" always wins over both, since a superset pair mid-round is
 * simultaneously "current" and, by the exhaustion math, sometimes technically
 * "done" on one member.
 */
export function railState(
  entries: readonly ExerciseEntry[],
  entry: ExerciseEntry,
  currentKeys: ReadonlySet<string>,
  isSkipped: (entry: ExerciseEntry) => boolean,
  isDone: (entry: ExerciseEntry) => boolean,
): ProgressState {
  if (isSkipped(entry)) return "skipped";
  if (currentKeys.has(entry.key)) return "current";
  if (isDone(entry)) return "done";
  const nextKey = entries.find(
    (candidate) =>
      !isSkipped(candidate) &&
      !isDone(candidate) &&
      !currentKeys.has(candidate.key),
  )?.key;
  return entry.key === nextKey ? "next" : "upcoming";
}
