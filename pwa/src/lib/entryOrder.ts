// TODAY'S ORDER: the sequence a lifter does the day's entries in.
//
// This is a PRESENTATION order, scoped to one session and held on this device
// beside `skips`, `subs` and `extras` (cacheKeys.sessionOrder). It is never
// the plan. Once any session points at a day, that day's prescriptions and
// their `position`s are locked (AGENTS.md, "Plan writes are locked"), and
// "I did the rows before the bench today" is a fact about today's
// performance, not an edit to what the coach wrote. Nothing in this file —
// and nothing that consumes it — may touch `set_index`, `prescription_id`,
// `prescriptions.position`, or anything that reaches Postgres. Entry KEYS are
// the first bracket's prescription id (or `extra:<exercise_id>`), so a set
// stays attributed to its slot wherever the slot is shown.
//
// THE UNIT IS THE ENTRY, NEVER A ROW. A ramp is already one entry. A superset
// is several consecutive entries sharing a `superset_group`; it is moved as
// one UNIT, its members kept adjacent and in their written A1/A2 order, so a
// reorder can never split a pair or swap who is A1.
//
// SECTIONS: an entry keeps the section the plan gave it. Moving "Face pulls"
// (Finisher) to the front does not make it Main Work, it makes the day read
// "FINISHER / Face pulls / MAIN WORK / Squat …". Section labels are rendered
// per RUN of same-section entries (WorkoutOverview), so a section can honestly
// appear twice and the label still tells the truth about each exercise. We do
// not pull entries back into their section (that would make the move look
// broken) and we do not relabel them (that would rewrite the plan's meaning).

import type { ExerciseEntry } from "./entries";

/** Consecutive same-group superset members, or a lone entry. */
export function entryUnits(
  entries: readonly ExerciseEntry[],
): ExerciseEntry[][] {
  const units: ExerciseEntry[][] = [];
  let group: number | null = null;
  for (const entry of entries) {
    const g = entry.brackets[0]?.superset_group ?? null;
    const last = units[units.length - 1];
    if (g !== null && g === group && last) last.push(entry);
    else units.push([entry]);
    group = g;
  }
  return units;
}

/**
 * `entries` in the lifter's order.
 *
 * `orderKeys` is the full key sequence last saved. Entries it does not name
 * (an extra added since, a fallback entry) keep their natural slot; keys that
 * name nothing any more (an extra removed, a re-parsed day) are ignored. A
 * unit is placed by its earliest-listed member, then members keep natural
 * order. Pure and idempotent; the input is never mutated.
 */
export function applyEntryOrder(
  entries: readonly ExerciseEntry[],
  orderKeys: readonly string[] | null | undefined,
): ExerciseEntry[] {
  if (!orderKeys || orderKeys.length === 0) return [...entries];
  const rank = new Map<string, number>();
  orderKeys.forEach((k, i) => {
    if (!rank.has(k)) rank.set(k, i);
  });
  const units = entryUnits(entries);
  const unitRank = (u: ExerciseEntry[]): number | null => {
    let best: number | null = null;
    for (const e of u) {
      const r = rank.get(e.key);
      if (r !== undefined && (best === null || r < best)) best = r;
    }
    return best;
  };
  const known = units
    .map((u, i) => ({ u, i, r: unitRank(u) }))
    .filter((x): x is { u: ExerciseEntry[]; i: number; r: number } => x.r !== null);
  const sorted = [...known].sort((a, b) => a.r - b.r || a.i - b.i);
  const result = [...units];
  known.forEach((slot, n) => {
    result[slot.i] = sorted[n].u;
  });
  return result.flat();
}

/** The key sequence after moving the unit at `from` to index `to` (unit
 *  indices, as `entryUnits` of the CURRENT display order). Null when the
 *  move is a no-op or out of range. */
export function orderKeysAfterMove(
  entries: readonly ExerciseEntry[],
  from: number,
  to: number,
): string[] | null {
  const units = entryUnits(entries);
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= units.length ||
    to >= units.length
  )
    return null;
  const next = [...units];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next.flat().map((e) => e.key);
}
