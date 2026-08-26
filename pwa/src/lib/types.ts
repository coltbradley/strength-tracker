// Row shapes for the tables and views the PWA touches.
// All loads are kg everywhere; conversion happens at the display edge only.

export type SetType = "warmup" | "working" | "backoff";

export interface ExerciseRow {
  id: string;
  name: string;
  equipment: string | null;
  primary_muscles: string[];
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
}

export interface PrescriptionPatch {
  sets?: number;
  reps_min?: number;
  reps_max?: number;
  load_kg?: number | null;
  load_pct_tm?: number | null;
  rest_seconds?: number | null;
  position?: number;
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
