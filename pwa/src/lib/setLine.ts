// How a LOGGED set reads back, in one place. The Last-set card, the List rows,
// the RPE sheet's logged rows and the Fix sheet all describe the same row, and
// three hand-rolled variants had already drifted ("20 kg x 2 x 10", "2.5 kg x
// 15" for a bodyweight set with a belt, "Plank x 0" for a timed hold).
//
// Rules, all from AGENTS.md: `load_kg` is the TOTAL, and `load_entry` records
// how it was typed, so a per-hand set is quoted per hand ("20 kg/side × 10");
// an authored number in the unit being shown is quoted as authored rather than
// as a converted-and-rounded kg value (225.25 lb stays 225.25, never 225.3);
// a null `load_entry` is unknown, not "total", and renders plainly.

import { formatAuthoredLoad, formatClock } from "./format";
import type { SetInsert } from "./types";
import type { Unit } from "./units";

export type SetTracking = "reps" | "time" | "done";

export interface SetLineOptions {
  unit: Unit;
  tracking?: SetTracking;
  /** No implement: a load on this movement is ADDED load (a belt or vest), and
   *  a zero load is no load at all rather than "0 kg". */
  bodyweight?: boolean;
}

function loadText(set: SetInsert, unit: Unit): string {
  return formatAuthoredLoad(
    set.load_kg,
    set.load_entry,
    set.entered_load,
    set.entered_unit,
    unit,
  );
}

/** "135 lb × 8", "8 reps", "8 reps · +25 lb added", "0:45 held", "Done". */
export function formatSetLine(set: SetInsert, options: SetLineOptions): string {
  const { unit, tracking = "reps", bodyweight = false } = options;
  if (tracking === "done") return "Done";
  if (tracking === "time") {
    const held = `${formatClock(set.duration_seconds ?? 0)} held`;
    return set.load_kg > 0 ? `${loadText(set, unit)} · ${held}` : held;
  }
  if (bodyweight) {
    return set.load_kg > 0
      ? `${set.reps} reps · +${loadText(set, unit)} added`
      : `${set.reps} reps`;
  }
  return `${loadText(set, unit)} × ${set.reps}`;
}

/**
 * Where a set sits in the way a lifter counts it: "warmup 1", "set 3".
 * `set_index` counts warmups too, so "set 4" for the third working set after
 * one warmup was wrong; this counts each kind on its own, within the set's own
 * exercise (a swapped entry holds two runs that both start at 0).
 */
export function setPositionLabel(
  set: SetInsert,
  sameEntrySets: readonly SetInsert[],
): { kind: "warmup" | "set"; number: number; text: string } {
  const kind = set.set_type === "warmup" ? "warmup" : "set";
  const number = Math.max(
    1,
    sameEntrySets.filter(
      (s) =>
        s.exercise_id === set.exercise_id &&
        (s.set_type === "warmup") === (set.set_type === "warmup") &&
        s.set_index <= set.set_index,
    ).length,
  );
  return { kind, number, text: `${kind} ${number}` };
}
