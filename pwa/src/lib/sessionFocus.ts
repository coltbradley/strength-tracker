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

// ---- superset rounds, member by member ------------------------------------
//
// A two-member superset is done in rounds (A1, A2, A1, A2), and the lifter
// logs ONE member at a time: each is its own set, its own durable local
// write. Everything below is arithmetic over how far each member has got; it
// holds no state, so Session can ask the same question for the card, the
// dock label, the rest decision and the recorded rest and never get two
// answers.

/** How far a member has got, for the display of a round. */
export interface RoundMemberProgress {
  /** working sets logged */
  progress: number;
  /** the plan's working sets; 0 means by feel (never "met") */
  target: number;
  /** skipped for today: a skipped member has nothing left to pair, so it
   *  counts as finished — a skipped A1 must never stay NOW, because then A2
   *  could never be logged at all. */
  skipped: boolean;
}

export type RoundCardState = "now" | "done" | "next" | "skipped";

export interface SupersetRoundView {
  /** which member the dock edits and logs right now */
  nowIndex: 0 | 1;
  /** one member is finished (target met or skipped) while the other goes on:
   *  every remaining set is its own "round" with a rest after it */
  tail: boolean;
  states: [RoundCardState, RoundCardState];
  /** 1-based round number and the number of rounds, for "round 2 of 4" */
  roundIndex: number;
  roundTotal: number;
}

export function memberFinished(member: RoundMemberProgress): boolean {
  return member.skipped || (member.target > 0 && member.progress >= member.target);
}

/**
 * The state of a live round, or null when both members are finished.
 *
 * NOW is the member with fewer sets logged (A1 when level); a finished
 * member is never NOW. `nowOverride` is the lifter tapping the other card to
 * log out of order (the partner's warmup, an A2 first) and is honoured only
 * while that member still has work to do.
 */
export function supersetRoundView(
  a: RoundMemberProgress,
  b: RoundMemberProgress,
  nowOverride: 0 | 1 | null = null,
): SupersetRoundView | null {
  const members = [a, b] as const;
  const finished = [memberFinished(a), memberFinished(b)] as const;
  if (finished[0] && finished[1]) return null;
  const tail = finished[0] !== finished[1];

  let nowIndex: 0 | 1;
  if (tail) nowIndex = finished[0] ? 1 : 0;
  else if (nowOverride !== null && !finished[nowOverride]) nowIndex = nowOverride;
  else nowIndex = a.progress <= b.progress ? 0 : 1;

  const cardState = (i: 0 | 1): RoundCardState => {
    if (i === nowIndex) return "now";
    if (finished[i]) return members[i].skipped ? "skipped" : "done";
    return members[i].progress > members[nowIndex].progress ? "done" : "next";
  };

  const now = members[nowIndex];
  const roundIndex = tail ? now.progress + 1 : Math.min(a.progress, b.progress) + 1;
  const roundTotal = tail
    ? now.target
    : a.target > 0 && b.target > 0
      ? Math.min(a.target, b.target)
      : Math.max(a.target, b.target);
  return {
    nowIndex,
    tail,
    states: [cardState(0), cardState(1)],
    roundIndex,
    roundTotal,
  };
}

/** One side of a logging decision, counted for the KIND of set being logged
 *  (working sets for a working set, warmups for a warmup). */
export interface RoundCount {
  /** sets of this kind already logged */
  progress: number;
  /** nothing of this kind left to do (met, skipped, or none planned) */
  finished: boolean;
}

export interface RoundPlacement {
  /** The partner is already AHEAD of me this round: the time since its set is
   *  the gap between the two halves of one round, not a rest, so this set's
   *  `rest_seconds_actual` is null (recording it would store A1's whole set as
   *  A2's "rest", on an append-only table that can never be corrected). */
  secondOfRound: boolean;
  /** After this log the partner is still to go this round: no rest, straight
   *  to the partner. Otherwise the round is complete and rest begins. */
  roundOpenAfter: boolean;
}

export function roundPlacement(
  mine: Pick<RoundCount, "progress">,
  partner: RoundCount | null,
): RoundPlacement {
  if (partner === null || partner.finished)
    return { secondOfRound: false, roundOpenAfter: false };
  return {
    secondOfRound: partner.progress > mine.progress,
    roundOpenAfter: partner.progress <= mine.progress,
  };
}
