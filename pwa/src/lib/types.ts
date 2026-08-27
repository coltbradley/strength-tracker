// Row shapes for the tables and views the PWA touches.
// All loads are kg everywhere; conversion happens at the display edge only.

export type SetType = "warmup" | "working" | "backoff";

/**
 * How a load was ENTERED. `load_kg` is always the TOTAL system load — the
 * whole weight moved in one rep — so every view, chart and MCP read stays
 * correct without asking "per hand or total?".
 *
 * - `"total"`    the value is the whole system: barbell, machine stack, or one
 *                implement on its own (a single-arm row IS total — one 30 kg
 *                dumbbell is the whole system for that rep).
 * - `"per_side"` the value was one side and both sides move together (a pair
 *                of dumbbells). `load_kg` = 2 x what the user typed; display
 *                and prefill divide by 2.
 * - `null`       not asserted: logged before the convention existed, or by a
 *                client that does not set it. NEVER treat null as "total" —
 *                `sets` is append-only, so those rows can never be corrected
 *                and their ambiguity is permanent.
 */
export type LoadEntry = "total" | "per_side";

/** The exercise library as the PWA reads it. `primary_muscles` exists on the
 *  table (and the MCP server selects it) but nothing in the app renders it,
 *  and it is a quarter of a ~110 kB response fetched on five paths — so it
 *  is deliberately absent from both the projection and this type. */
export interface ExerciseRow {
  id: string;
  name: string;
  equipment: string | null;
}

export interface ProgramRow {
  id: string;
  name: string;
  source_note: string | null;
  created_at: string;
  confirmed_at: string | null;
}

export interface PlannedWorkoutRow {
  id: string;
  program_id: string;
  day_index: number;
  label: string | null;
  /** coach notes, written by the MCP program parse */
  notes: string | null;
  /** calendar date (YYYY-MM-DD) — gates the Start button to today */
  scheduled_date: string | null;
  /** the user's own pre-workout planning note, edited in the app */
  plan_note: string | null;
  skipped_at: string | null;
}

/** Owner-editable planning fields on planned_workouts. */
export interface PlannedWorkoutPatch {
  label?: string | null;
  scheduled_date?: string | null;
  plan_note?: string | null;
  skipped_at?: string | null;
  day_index?: number;
}

/** Raw prescriptions insert/update shape (PWA plan editor). */
export interface PrescriptionInsert {
  id: string;
  planned_workout_id: string;
  exercise_id: string;
  position: number;
  sets: number;
  reps_min: number;
  reps_max: number;
  load_kg: number | null;
  load_pct_tm: number | null;
  rest_seconds: number | null;
  notes: string | null;
  /** total-vs-per-side convention for load_kg; omit when not asserted */
  load_entry?: LoadEntry | null;
}

export interface PrescriptionPatch {
  sets?: number;
  reps_min?: number;
  reps_max?: number;
  load_kg?: number | null;
  load_pct_tm?: number | null;
  rest_seconds?: number | null;
  position?: number;
  superset_group?: number | null;
  load_entry?: LoadEntry | null;
}

export interface ResolvedPrescriptionRow {
  id: string;
  planned_workout_id: string;
  exercise_id: string;
  exercise_name: string;
  position: number;
  sets: number;
  reps_min: number;
  reps_max: number;
  rest_seconds: number | null;
  notes: string | null;
  load_kg: number | null;
  load_pct_tm: number | null;
  tm_kg: number | null;
  resolved_load_kg: number | null;
  plate_load_kg: number | null;
  /** exercises sharing a group in the same workout are a superset (1=A, 2=B) */
  superset_group: number | null;
  /** how load_kg / resolved_load_kg is expressed to the lifter; both are
   *  totals either way. null = the parse or editor did not assert it.
   *  Optional because prescriptions cached offline before this field, and
   *  select lists that predate it, simply omit it. */
  load_entry?: LoadEntry | null;
}

// Insert shape; user_id is filled by the DB default (auth.uid()).
export interface SessionInsert {
  id: string;
  planned_workout_id: string | null;
  started_at: string;
}

export interface SessionEndPatch {
  ended_at: string;
  session_rpe: number | null;
  bodyweight_kg: number | null;
  notes: string | null;
}

/** Soft delete: the session (and its sets) leave every view but stay stored. */
export interface SessionDiscardPatch {
  discarded_at: string;
}

export type SessionPatch = SessionEndPatch | SessionDiscardPatch;

/** Append-only correction: hides one set from every view. */
export interface SetVoidInsert {
  set_id: string;
}

/** User annotation on one logged set; editable (last write wins). */
export interface SetNoteUpsert {
  set_id: string;
  note: string;
}

export interface SetInsert {
  id: string;
  session_id: string;
  exercise_id: string;
  prescription_id: string | null;
  set_index: number;
  set_type: SetType;
  load_kg: number;
  reps: number;
  performed_at: string;
  /** rest taken BEFORE this set, seconds (null on the first set of an
   *  exercise or when the timer state was lost); DB caps at 3600 */
  rest_seconds_actual: number | null;
  /** how load_kg was entered. Optional: rows written before the convention
   *  (and reads whose column list predates it) simply carry no assertion.
   *  DB rejects "per_side" on a 0 kg bodyweight set. */
  load_entry?: LoadEntry | null;
}

/**
 * One dated training-max value. The table is HISTORY-carrying:
 * `(user_id, exercise_id, effective_date)` is unique and the row with the
 * latest `effective_date <= today` is the one that resolves a % TM
 * prescription (`v_current_tm`). A future-dated row is scheduled, not
 * current — see `currentTrainingMax` in lib/data.ts.
 */
export interface TrainingMaxRow {
  id: string;
  exercise_id: string;
  value_kg: number;
  /** YYYY-MM-DD, the day this value took effect */
  effective_date: string;
}

/**
 * One logged working/backoff set beside the prescription it fulfilled
 * (`v_adherence`). Both loads are TOTAL system load, so the numbers are
 * directly comparable — EXCEPT where an entry mode is null, which means "not
 * asserted", never "total" (see LoadEntry).
 */
export interface AdherenceRow {
  set_id: string;
  session_id: string;
  exercise_id: string;
  prescription_id: string;
  set_index: number;
  performed_at: string;
  actual_load_kg: number;
  actual_reps: number;
  reps_min: number;
  reps_max: number;
  prescribed_load_kg: number | null;
  load_delta_kg: number | null;
  rep_outcome: "hit" | "missed" | "exceeded";
  actual_load_entry: LoadEntry | null;
  prescribed_load_entry: LoadEntry | null;
}

export interface SessionBestE1rmRow {
  exercise_id: string;
  session_id: string;
  performed_at: string;
  best_e1rm_kg: number;
}

export interface WeeklyVolumeRow {
  exercise_id: string;
  week_start: string;
  working_sets: number;
  tonnage_kg: number;
}

export interface GoalProgressRow {
  goal_id: string;
  exercise_id: string;
  exercise_name: string;
  target_e1rm_kg: number;
  target_date: string | null;
  recent_best_e1rm_kg: number | null;
  alltime_best_e1rm_kg: number | null;
  pct_of_target: number | null;
}

// Metadata about the in-flight (started, not ended) session, cached locally.
export interface ActiveSession {
  id: string;
  planned_workout_id: string | null;
  started_at: string;
  workout_label: string | null;
  /** snapshot of the day's notes so they're readable mid-workout, offline
   *  (optional: sessions cached before this field simply omit them) */
  plan_note?: string | null;
  coach_note?: string | null;
}
