// The workout's SHAPE: how prescriptions become the list of exercises a
// screen renders, and which logged sets belong to which of them.
//
// Pure functions of plain data — no React, no cache, no network — because
// every rule in here has a permanent consequence:
//  - `groupRamps` defines what "one exercise" means. The Session accordion
//    and the Today preview must agree, or the day silently has a different
//    number of exercises depending on which screen you look at.
//  - `bracketFor` decides the `prescription_id` a set is stamped with, and
//    `sets` is append-only: a wrong link can never be corrected, only voided.
//    Warmups and working sets are two SEPARATE runs through the brackets —
//    one cursor for both is how a prescribed warmup ate the first working
//    bracket, and `targetSets`/`progressSets` are the matching pair that
//    keeps the plan's target and the lifter's progress counted one way.
//  - `buildEntries`/`setsForEntry` enforce "no logged set may be invisible".
//    A set nothing renders cannot be voided or corrected from the UI, so the
//    lifter re-logs it and the record carries a duplicate forever.

import type { ResolvedPrescriptionRow, SetInsert } from "./types";

/** An exercise as the session screen lists it: one accordion item. */
export interface ExerciseEntry {
  /** first bracket's prescription id, or `extra:<exercise_id>` */
  key: string;
  exercise_id: string;
  name: string;
  /** consecutive prescriptions for this exercise (a coach's ramp brackets,
   *  e.g. 1×8-15, 1×6-8, 3×3-5) — ONE entry, walked through in order.
   *  Empty = unprescribed. */
  brackets: ResolvedPrescriptionRow[];
}

/**
 * A set-group declared mid-session for an exercise the plan did not prescribe.
 * Same shape the plan editor writes, but device-local: it never reaches
 * `prescriptions`, which belongs to planned days.
 */
export interface DeclaredGroup {
  sets: number;
  reps_min: number;
  reps_max: number;
  load_kg: number | null;
  set_type: string;
  rest_seconds: number;
  /** 0 = not in a superset; 1-4 = group A-D */
  superset_group?: number;
  /** Heading this sits under; null/absent = the main body of the workout.
   *  Optional because extras cached before sections existed have neither. */
  section?: string | null;
  /** How it is logged. Absent means 'reps', which is what every extra
   *  declared before tick-only movements existed was. */
  tracking?: ResolvedPrescriptionRow["tracking"];
}

/** An exercise added mid-session that the plan did not prescribe. */
export interface ExtraExercise {
  exercise_id: string;
  name: string;
  /** What was declared when it was added: "3 sets of 10 at 60, first a
   *  warmup". Absent for extras added before this existed, and for anything
   *  added without a scheme — those simply have no target, as before. */
  scheme?: DeclaredGroup[];
}

/**
 * A bracket id that is NOT a real prescription.
 *
 * Declared groups are synthesised into brackets so every target the session
 * screen already computes — "SET 2 OF 5", the load prefill, the warmup marker
 * — works for an unplanned exercise with no new code. But `sets.prescription_id`
 * is a foreign key, so a set must never link to one of these: the insert would
 * fail, and on the offline queue it would fail forever.
 */
export const LOCAL_BRACKET = "local:";

export function isLocalBracket(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(LOCAL_BRACKET);
}

/**
 * Collapse a prescription list into ramp groups.
 *
 * Two consecutive prescriptions are the same exercise's ramp when the
 * exercise matches AND the superset group matches. Both clauses matter: the
 * superset clause is what keeps `A1 bench / A1 bench` (a ramp inside a
 * superset) separate from the same exercise programmed outside the superset,
 * and it is the clause a rewrite is most likely to drop. NON-consecutive
 * repeats (squat early, squat finisher) stay distinct on purpose.
 */
export function groupRamps(
  rx: ResolvedPrescriptionRow[],
): ResolvedPrescriptionRow[][] {
  const groups: ResolvedPrescriptionRow[][] = [];
  for (const r of rx) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last[0].exercise_id === r.exercise_id &&
      last[0].superset_group === r.superset_group
    )
      last.push(r);
    else groups.push([r]);
  }
  return groups;
}

/**
 * Which COUNT a bracket belongs to.
 *
 * A prescribed warmup and the working sets it leads into are two separate
 * runs, counted separately, and the plan's "3×8" means three WORKING sets
 * whatever the coach wrote above it. `backoff` is a legal legacy value and
 * counts as work — it is sets you are asked to do, and dropping it from the
 * target would make an old plan un-finishable. An ABSENT set_type reads as
 * 'working': rows cached before the column existed carry none, and treating
 * those as warmups would silently empty the target of every such day.
 */
export type BracketKind = "warmup" | "working";

export function bracketKind(b: ResolvedPrescriptionRow): BracketKind {
  return b.set_type === "warmup" ? "warmup" : "working";
}

/**
 * Prescribed WORKING sets across an entry's brackets — the "OF n" in
 * "SET 2 OF 5", and (through `targetSets`) what done-ness is measured
 * against.
 *
 * This summed every bracket, warmups included, while the count on the other
 * side of the comparison (`workingCount` in Session) only ever counted
 * working sets. So a day written as "1×12 warmup, then 3×8" read as
 * "1 OF 4" and could never reach 4: the entry stayed un-done forever, and
 * the honest way to finish it was to log the warmup as working — which is
 * exactly the mis-logging the set_type column exists to prevent.
 */
export function workingSets(entry: ExerciseEntry): number {
  return entry.brackets.reduce(
    (n, b) => (bracketKind(b) === "working" ? n + b.sets : n),
    0,
  );
}

/** Prescribed warmup sets. Its own count, never added to the target: the
 *  label says "WARMUP 1 OF 2" from this and "SET 1 OF 3" from the other. */
export function warmupSets(entry: ExerciseEntry): number {
  return entry.brackets.reduce(
    (n, b) => (bracketKind(b) === "warmup" ? n + b.sets : n),
    0,
  );
}

/**
 * The number an entry is FINISHED against, and how far along it is.
 *
 * Working sets, except for the one day that has none: a prep drill written
 * entirely as warmups would otherwise be born complete — `workingSets` is 0
 * and every count is `>= 0` — so it would show as done before a rep of it
 * was done, and the whole workout's "3 OF 8 DONE" would be wrong with it.
 * When a plan asks only for warmups, the warmups ARE the work.
 *
 * The pair must always be read together: a target counted one way and a
 * progress counted the other is the bug this round is fixing.
 */
export function targetSets(entry: ExerciseEntry): number {
  const work = workingSets(entry);
  return work > 0 ? work : warmupSets(entry);
}

export function progressSets(
  entry: ExerciseEntry,
  own: { set_type: string }[],
): number {
  if (entry.brackets.length === 0) return own.length;
  return workingSets(entry) > 0
    ? own.filter((s) => s.set_type !== "warmup").length
    : own.filter((s) => s.set_type === "warmup").length;
}

/** Has this entry met what its plan asked for? An unprescribed entry has no
 *  plan to meet, so one logged set is all it takes. */
export function entryMet(
  entry: ExerciseEntry,
  own: { set_type: string }[],
): boolean {
  return entry.brackets.length > 0
    ? progressSets(entry, own) >= targetSets(entry)
    : own.length > 0;
}

/**
 * The bracket the (n+1)th set of `kind` falls into.
 *
 * The two runs are walked SEPARATELY: n is the count of sets already logged
 * of that same kind, matched against the brackets of that kind only.
 * Walking one cursor through both is how a warmup used to consume the first
 * working bracket — the coach's "1×12 @ 10 warmup, 3×8 @ 20" prefilled the
 * warmup's 10 kg for working set one, and the set linked to the wrong
 * prescription permanently (`sets` is append-only).
 *
 * When the entry has no bracket of the asked-for kind the whole list is
 * walked instead, which preserves the older behaviour deliberately: a warmup
 * taken by feel on a plan that never mentioned one still links to the
 * working bracket it leads into, rather than to nothing.
 */
export function bracketFor(
  entry: ExerciseEntry,
  n: number,
  kind: BracketKind = "working",
): ResolvedPrescriptionRow | null {
  const matching = entry.brackets.filter((b) => bracketKind(b) === kind);
  const pool = matching.length > 0 ? matching : entry.brackets;
  let acc = 0;
  for (const b of pool) {
    acc += b.sets;
    if (n < acc) return b;
  }
  return pool[pool.length - 1] ?? null;
}

/** a set whose prescription link points at nothing in this session's
 *  snapshot (null, or a prescription since deleted) */
export function isOrphanSet(s: SetInsert, knownRxIds: Set<string>): boolean {
  return s.prescription_id === null || !knownRxIds.has(s.prescription_id);
}

/**
 * A declared group as the row shape the session screen reads.
 *
 * Every field the screen touches is filled; the rest are the nulls an
 * unresolved prescription would carry anyway. The id marks it local so a set
 * logged against it links to no prescription at all.
 */
function declaredToBracket(
  g: DeclaredGroup,
  e: ExtraExercise,
  i: number,
): ResolvedPrescriptionRow {
  return {
    id: `${LOCAL_BRACKET}${e.exercise_id}:${i}`,
    planned_workout_id: "",
    exercise_id: e.exercise_id,
    exercise_name: e.name,
    position: i,
    sets: g.sets,
    reps_min: g.reps_min,
    reps_max: g.reps_max,
    rest_seconds: g.rest_seconds,
    notes: null,
    load_kg: g.load_kg,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: g.load_kg,
    plate_load_kg: g.load_kg,
    superset_group:
      g.superset_group !== undefined && g.superset_group > 0
        ? g.superset_group
        : null,
    set_type: g.set_type as ResolvedPrescriptionRow["set_type"],
    // Both of these were dropped on the floor. SetSchemeSheet asks for them
    // when an exercise is added mid-session, and neither reached the entry:
    // picking "tick only" for a banded glute bridge still produced a load and
    // a reps stepper (`isTick` reads brackets[0].tracking), and picking a
    // section filed it nowhere. Anything you can say while planning has to
    // mean the same thing when you say it on the gym floor.
    section: g.section ?? null,
    tracking: g.tracking ?? "reps",
  };
}

/**
 * The accordion list for a session: prescribed entries (ramps collapsed),
 * then mid-session extras, then a synthesized entry for any exercise that
 * has orphan sets and no home yet (lost extras cache, plan edited
 * mid-session, sets logged on another device).
 */
export function buildEntries(
  rx: ResolvedPrescriptionRow[],
  extras: ExtraExercise[],
  sets: SetInsert[],
  exercises: { id: string; name: string }[],
): ExerciseEntry[] {
  const fromRx: ExerciseEntry[] = groupRamps(rx).map((brackets) => ({
    key: brackets[0].id,
    exercise_id: brackets[0].exercise_id,
    name: brackets[0].exercise_name,
    brackets,
  }));
  const covered = new Set(fromRx.map((f) => f.exercise_id));
  const extraEntries: ExerciseEntry[] = extras
    .filter((e) => !covered.has(e.exercise_id))
    .map((e) => ({
      key: `extra:${e.exercise_id}`,
      exercise_id: e.exercise_id,
      name: e.name,
      // A declared scheme becomes brackets, so the target, the prefill and the
      // warmup handling all come from the code that already does it for a
      // planned exercise. No scheme = no brackets = "LOG SET n", as before.
      brackets: (e.scheme ?? []).map((g, i) => declaredToBracket(g, e, i)),
    }));
  for (const e of extraEntries) covered.add(e.exercise_id);
  const knownRxIds = new Set(rx.map((r) => r.id));
  const orphanIds = [
    ...new Set(
      sets
        .filter(
          (s) => !covered.has(s.exercise_id) && isOrphanSet(s, knownRxIds),
        )
        .map((s) => s.exercise_id),
    ),
  ];
  const fallback: ExerciseEntry[] = orphanIds.map((id) => ({
    key: `extra:${id}`,
    exercise_id: id,
    name: exercises.find((e) => e.id === id)?.name ?? id.replace(/_/g, " "),
    brackets: [],
  }));
  return [...fromRx, ...extraEntries, ...fallback];
}

/**
 * The sets that belong to one entry.
 *
 * The FIRST rx entry for an exercise also claims that exercise's orphan
 * sets, so nothing logged can disappear from the UI. An unprescribed entry
 * owns its exercise's orphan sets outright.
 */
export function setsForEntry(
  entry: ExerciseEntry,
  sets: SetInsert[],
  rx: ResolvedPrescriptionRow[],
  knownRxIds: Set<string>,
): SetInsert[] {
  // A locally DECLARED scheme is a target, not an attribution key. Its
  // brackets exist only in this device's cache and its sets carry
  // prescription_id null on purpose (the column is a foreign key), so it must
  // claim by exercise like an undeclared extra — matching on bracket ids would
  // attribute nothing and the counter would sit at "SET 1 OF 4" forever.
  const declaredLocally =
    entry.brackets.length > 0 &&
    entry.brackets.every((b) => isLocalBracket(b.id));

  if (entry.brackets.length > 0 && !declaredLocally) {
    const ids = new Set(entry.brackets.map((b) => b.id));
    const claimsOrphans =
      rx.find((r) => r.exercise_id === entry.exercise_id)?.id === entry.key;
    return sets.filter(
      (s) =>
        (s.prescription_id !== null && ids.has(s.prescription_id)) ||
        (claimsOrphans &&
          s.exercise_id === entry.exercise_id &&
          isOrphanSet(s, knownRxIds)),
    );
  }
  return sets.filter(
    (s) => s.exercise_id === entry.exercise_id && isOrphanSet(s, knownRxIds),
  );
}

/** A1/A2 tags and bracket-rail position for supersetted entries. */
export interface SupersetTag {
  tag: string;
  first: boolean;
  last: boolean;
}

/** 1 -> "A", 2 -> "B". */
export function supersetLetter(group: number): string {
  return String.fromCharCode(64 + group);
}

/**
 * The run of consecutive entries that share the open entry's superset group.
 *
 * Returns null when the entry is in no group, and when it is the only member
 * of one: a group of one has nobody to alternate with, which is the same
 * rule `supersetInfo` uses to decide whether to show a tag at all. The two
 * must agree — an A1 rail with no A2 anywhere, or a "next" that points at a
 * partner the rail never drew, are both the app describing a day it is not
 * showing.
 */
function supersetRun(
  entries: ExerciseEntry[],
  index: number,
): ExerciseEntry[] | null {
  const groupOf = (i: number) =>
    entries[i]?.brackets[0]?.superset_group ?? null;
  const group = groupOf(index);
  if (group === null) return null;
  let start = index;
  let end = index;
  while (start > 0 && groupOf(start - 1) === group) start--;
  while (end < entries.length - 1 && groupOf(end + 1) === group) end++;
  return end > start ? entries.slice(start, end + 1) : null;
}

/**
 * Mid-superset, the partner you are meant to do NEXT: the next member of the
 * open entry's group that is not finished, wrapping past the end of the run
 * back to its start.
 *
 * A superset is done in rounds — A1, A2, A1, A2 — so the useful suggestion
 * arrives after EVERY set, not once the open exercise is complete. The
 * screen's `nextEntry` only appears when the open entry is done, which is
 * never true mid-round, so the lifter scrolled and tapped A2 by hand every
 * single time.
 *
 * Wrapping is what makes it a round rather than a list: standing on A2 with
 * A1 still outstanding, the answer is A1. Null when every other member is
 * finished — the round is over and the ordinary "next exercise" hint takes
 * the lead again. Suggestion only; nothing here enforces logging order.
 */
export function supersetPartner(
  entries: ExerciseEntry[],
  openKey: string | null,
  isDone: (entry: ExerciseEntry) => boolean,
): ExerciseEntry | null {
  if (openKey === null) return null;
  const index = entries.findIndex((e) => e.key === openKey);
  if (index < 0) return null;
  const run = supersetRun(entries, index);
  if (run === null) return null;
  const here = run.findIndex((e) => e.key === openKey);
  for (let step = 1; step < run.length; step++) {
    const candidate = run[(here + step) % run.length];
    if (!isDone(candidate)) return candidate;
  }
  return null;
}

/**
 * Tag consecutive entries that share a non-null superset group. A group with
 * only ONE member is not a superset — it has no partner to alternate with —
 * so it gets no tag at all.
 */
export function supersetInfo(
  entries: ExerciseEntry[],
): Map<string, SupersetTag> {
  const map = new Map<string, SupersetTag>();
  let i = 0;
  while (i < entries.length) {
    const group = entries[i].brackets[0]?.superset_group ?? null;
    if (group === null) {
      i++;
      continue;
    }
    let j = i;
    while (
      j < entries.length &&
      (entries[j].brackets[0]?.superset_group ?? null) === group
    )
      j++;
    if (j - i > 1) {
      const letter = supersetLetter(group);
      for (let k = i; k < j; k++)
        map.set(entries[k].key, {
          tag: `${letter}${k - i + 1}`,
          first: k === i,
          last: k === j - 1,
        });
    }
    i = j;
  }
  return map;
}
