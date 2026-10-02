import type { PrescriptionInsert } from "./types";

/**
 * The columns a prescription copy must read. Duplicate, save-as-template and
 * apply-template all copy a day, and a day's shape is more than its numbers:
 * warmups (`set_type`), headings (`section`), supersets (`superset_group`),
 * timed and tick rows (`tracking`), and how a load was typed. One list, so a
 * column added to one path cannot be forgotten in the other two (PLAN-1,
 * PLAN-2).
 */
export const PRESCRIPTION_COPY_COLUMNS =
  "exercise_id,position,sets,reps_min,reps_max,load_kg,load_pct_tm,rest_seconds,notes,set_type,section,tracking,superset_group,load_entry,entered_load,entered_unit";

export type PrescriptionCopySource = Pick<
  PrescriptionInsert,
  | "exercise_id"
  | "position"
  | "sets"
  | "reps_min"
  | "reps_max"
  | "load_kg"
  | "load_pct_tm"
  | "rest_seconds"
  | "notes"
> &
  Partial<
    Pick<
      PrescriptionInsert,
      | "set_type"
      | "section"
      | "tracking"
      | "superset_group"
      | "load_entry"
      | "entered_load"
      | "entered_unit"
    >
  >;

/**
 * One insert row for a copied prescription. EVERY column is emitted on every
 * row: a PostgREST bulk insert fills a missing key with NULL, not the column
 * default, so a row that omits `set_type` turns into a NULL in a NOT NULL
 * column the moment another row in the same array names it (AGENTS.md).
 */
export function copyPrescriptionRow(
  src: PrescriptionCopySource,
  ids: { id: string; planned_workout_id: string; position?: number },
): PrescriptionInsert {
  return {
    id: ids.id,
    planned_workout_id: ids.planned_workout_id,
    exercise_id: src.exercise_id,
    position: ids.position ?? src.position,
    sets: src.sets,
    reps_min: src.reps_min,
    reps_max: src.reps_max,
    load_kg: src.load_kg ?? null,
    load_pct_tm: src.load_pct_tm ?? null,
    rest_seconds: src.rest_seconds ?? null,
    notes: src.notes ?? null,
    set_type: src.set_type ?? "working",
    section: src.section ?? null,
    tracking: src.tracking ?? "reps",
    superset_group: src.superset_group ?? null,
    load_entry: src.load_entry ?? null,
    entered_load: src.entered_load ?? null,
    entered_unit: src.entered_unit ?? null,
  };
}
