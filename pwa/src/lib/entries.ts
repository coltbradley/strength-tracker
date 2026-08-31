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

/** total prescribed working sets across an entry's brackets */
export function totalSets(entry: ExerciseEntry): number {
  return entry.brackets.reduce((n, b) => n + b.sets, 0);
}

/** the bracket the (n+1)th working set falls into */
export function bracketFor(
  entry: ExerciseEntry,
  n: number,
): ResolvedPrescriptionRow | null {
  let acc = 0;
  for (const b of entry.brackets) {
    acc += b.sets;
    if (n < acc) return b;
  }
  return entry.brackets[entry.brackets.length - 1] ?? null;
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
      brackets: (e.scheme ?? []).map((g, i) =>
        declaredToBracket(g, e, i),
      ),
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
    entry.brackets.length > 0 && entry.brackets.every((b) => isLocalBracket(b.id));

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
