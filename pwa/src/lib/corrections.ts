// Correcting a logged set. `sets` is append-only and a row is never edited,
// so a correction is two appends: a void of the old row and a new row that
// takes its place — the same set_index, the same performed_at, the same rest,
// the same prescription. Everything that says WHERE the set sits in the
// workout is kept; only what was lifted — load, reps, type, and how hard it
// felt — changes. Relogging by hand got the
// next index instead, which turned a corrected set 2 into set 5 and left the
// LOGGED list ordered by when the typo was noticed rather than when the set
// was done.

import type { LoadEntry, SetInsert, SetType } from "./types";
import { uuid } from "./uuid";

export interface Correction {
  /** ALWAYS the total system load, like the column */
  load_kg: number;
  reps: number;
  set_type: SetType;
  load_entry: LoadEntry | null;
  /** how hard it felt, or null for unrated — which is an answer, not a gap.
   *  A correction is the ONLY way to rate a set after the fact. */
  rpe: number | null;
}

/** The replacement row: a fresh id, the old row's place, the new numbers. */
export function correctedSet(old: SetInsert, next: Correction): SetInsert {
  return {
    ...old,
    id: uuid(),
    load_kg: next.load_kg,
    reps: next.reps,
    set_type: next.set_type,
    load_entry: next.load_entry,
    rpe: next.rpe,
  };
}

/**
 * A correction that changes nothing writes nothing: a void plus an identical
 * re-insert would leave history the same and the outbox two rows longer.
 * `load_entry` is deliberately not compared — it describes how the number
 * was typed, and retyping the same total the other way is not a different
 * set.
 *
 * `rpe` IS compared: how hard a set felt is a fact about the set, so changing
 * only the rating is a real correction — and re-tapping the rating it already
 * had is not. The old value is normalised because it can be ABSENT (a row
 * cached before the column existed, or read through a column list that
 * predates it) and `undefined === null` is false; without that, saving an
 * unrated set unrated would void it and write a duplicate.
 */
export function isNoopCorrection(old: SetInsert, next: Correction): boolean {
  return (
    old.load_kg === next.load_kg &&
    old.reps === next.reps &&
    old.set_type === next.set_type &&
    (old.rpe ?? null) === next.rpe
  );
}
