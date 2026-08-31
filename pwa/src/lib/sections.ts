// What a section contains, and where its heading goes.
//
// `prescriptions.section` is a nullable name on a row, and consecutive rows
// sharing it render under one heading. That leaves two things the column
// itself cannot say, and both were wrong:
//
//  - A section holds WHOLE exercises. Assigning one to a single row split a
//    ramp down the middle (bracket 1 under "ACTIVATIONS", brackets 2 and 3
//    outside it) and did the same to a superset, which is worse: the pairing
//    is the prescription, so a superset straddling a heading describes a day
//    nobody can perform.
//  - A section has ONE heading. Marking a row as the head whenever the row
//    above it differed printed "ABS" twice for a section that was interrupted
//    and resumed, which reads as two sections that happen to share a name.
//
// Pure functions of plain rows, so the rule is testable and the plan editor
// stays a screen.

import type { ResolvedPrescriptionRow } from "./types";

/**
 * Are these two ADJACENT rows one thing to the lifter?
 *
 * The same two rules the rest of the app already draws: a ramp is
 * `groupRamps`' (same exercise AND same superset group), a superset run is
 * `supersetInfo`'s (consecutive rows sharing a letter). Written as one
 * predicate because a superset run always swallows the ramps inside it —
 * groupRamps only ever groups rows that already agree on the letter.
 *
 * Consecutive-only, deliberately: a non-adjacent row sharing the letter is a
 * separate run to every other screen, and reaching across the rows between it
 * would put a heading on a row far from the one being edited.
 */
function bound(
  a: ResolvedPrescriptionRow,
  b: ResolvedPrescriptionRow,
): boolean {
  return (
    a.superset_group === b.superset_group &&
    (a.superset_group !== null || a.exercise_id === b.exercise_id)
  );
}

/**
 * Every row that a section assignment on row `i` has to carry with it,
 * `i` included, in list order. A row bound to nothing is its own unit.
 */
export function sectionUnit(
  rows: ResolvedPrescriptionRow[],
  i: number,
): ResolvedPrescriptionRow[] {
  if (rows[i] === undefined) return [];
  let lo = i;
  while (lo > 0 && bound(rows[lo - 1], rows[lo])) lo--;
  let hi = i;
  while (hi + 1 < rows.length && bound(rows[hi], rows[hi + 1])) hi++;
  return rows.slice(lo, hi + 1);
}

/**
 * Where row `i` sits in its section, or null when it sits in the main body.
 *
 * `first` is the FIRST OCCURRENCE of the name in the whole list, not merely a
 * change from the row above, so one section name can only ever produce one
 * heading.
 */
export function sectionAt(
  rows: ResolvedPrescriptionRow[],
  i: number,
): { name: string; first: boolean } | null {
  const sec = rows[i]?.section ?? null;
  if (sec === null || sec.trim() === "") return null;
  return {
    name: sec,
    first: !rows.slice(0, i).some((o) => (o.section ?? null) === sec),
  };
}
