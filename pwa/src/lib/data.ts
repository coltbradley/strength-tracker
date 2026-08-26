// Read layer: online-first with IndexedDB cache fallback, so the app stays
// usable offline mid-gym. Session-critical reads (today's prescriptions,
// exercise list, last actuals) are cached; locally queued sets are merged in
// by callers so the UI reflects unsynced work.

import { supabase } from "./supabase";
import {
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheDeleteByPrefix,
  cacheKeys,
} from "./db";
import { reportError } from "./errors";
import { uuid } from "./uuid";
import type {
  ExerciseRow,
  GoalProgressRow,
  PlannedWorkoutPatch,
  PlannedWorkoutRow,
  PrescriptionInsert,
  PrescriptionPatch,
  ProgramRow,
  ResolvedPrescriptionRow,
  SessionBestE1rmRow,
  SetInsert,
  WeeklyVolumeRow,
} from "./types";

/** Column list for every `sets` select — one place, matches SetInsert. */
const SET_COLUMNS =
  "id,session_id,exercise_id,prescription_id,set_index,set_type,load_kg,reps,performed_at,rest_seconds_actual";

async function fetchWithCache<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<{ data: T; fromCache: boolean }> {
  try {
    const data = await fetcher();
    await cacheSet(key, data);
    return { data, fromCache: false };
  } catch (e) {
    const cached = await cacheGet<T>(key);
    if (cached !== undefined) return { data: cached, fromCache: true };
    throw e;
  }
}

function throwIf(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

// ---- programs / planned workouts ------------------------------------------

export interface WorkoutList {
  programs: ProgramRow[];
  workouts: PlannedWorkoutRow[];
}

/** Week display order: chronological when dates exist, coach order
 *  (day_index) otherwise. The Today list and the plan editor's
 *  earlier/later buttons must agree on this. */
export function weekOrder(a: PlannedWorkoutRow, b: PlannedWorkoutRow): number {
  if (a.scheduled_date && b.scheduled_date)
    return (
      a.scheduled_date.localeCompare(b.scheduled_date) ||
      a.day_index - b.day_index
    );
  if (a.scheduled_date) return -1;
  if (b.scheduled_date) return 1;
  return a.day_index - b.day_index;
}

export async function getPlannedWorkouts(): Promise<{
  data: WorkoutList;
  fromCache: boolean;
}> {
  return fetchWithCache(cacheKeys.plannedWorkouts, async () => {
    const { data: programs, error: pErr } = await supabase
      .from("programs")
      .select("id,name,source_note,created_at,confirmed_at")
      .not("confirmed_at", "is", null)
      .order("created_at", { ascending: false });
    throwIf(pErr);
    const progs = (programs ?? []) as ProgramRow[];
    if (progs.length === 0) return { programs: [], workouts: [] };
    const { data: workouts, error: wErr } = await supabase
      .from("planned_workouts")
      .select(
        "id,program_id,day_index,label,notes,scheduled_date,plan_note,skipped_at",
      )
      .in(
        "program_id",
        progs.map((p) => p.id),
      )
      .order("day_index");
    throwIf(wErr);
    return {
      programs: progs,
      workouts: (workouts ?? []) as PlannedWorkoutRow[],
    };
  });
}

// ---- plan editing ----------------------------------------------------------
// Planning writes are online-only (planning happens at home, not mid-gym) and
// go straight to Supabase — the offline outbox stays reserved for the
// session-critical tables. Every mutation invalidates the caches it touches
// so the next read refetches.

async function invalidatePlanCaches(plannedWorkoutId?: string): Promise<void> {
  await cacheDelete(cacheKeys.plannedWorkouts);
  if (plannedWorkoutId)
    await cacheDelete(cacheKeys.prescriptions(plannedWorkoutId));
}

export async function updatePlannedWorkout(
  id: string,
  patch: PlannedWorkoutPatch,
): Promise<void> {
  const { error } = await supabase
    .from("planned_workouts")
    .update(patch)
    .eq("id", id);
  throwIf(error);
  await invalidatePlanCaches(id);
}

/** Swap the week position of two workouts: both day_index (coach order;
 *  unique per program, so one routes through a temporary slot) and
 *  scheduled_date (calendar position). "Move leg day before push day" swaps
 *  the days wholesale. */
export async function swapWorkoutOrder(
  a: PlannedWorkoutRow,
  b: PlannedWorkoutRow,
): Promise<void> {
  const temp = 10000 + b.day_index;
  const step = async (
    id: string,
    patch: { day_index: number; scheduled_date?: string | null },
  ) => {
    const { error } = await supabase
      .from("planned_workouts")
      .update(patch)
      .eq("id", id);
    throwIf(error);
  };
  await step(a.id, { day_index: temp });
  await step(b.id, {
    day_index: a.day_index,
    scheduled_date: a.scheduled_date,
  });
  await step(a.id, {
    day_index: b.day_index,
    scheduled_date: b.scheduled_date,
  });
  await invalidatePlanCaches();
}

/** Copy a workout (and its prescriptions) onto another calendar date, at the
 *  end of the program's day order. */
export async function duplicatePlannedWorkout(
  workout: PlannedWorkoutRow,
  targetDate: string | null,
): Promise<string> {
  const { data: maxRows, error: mErr } = await supabase
    .from("planned_workouts")
    .select("day_index")
    .eq("program_id", workout.program_id)
    .order("day_index", { ascending: false })
    .limit(1);
  throwIf(mErr);
  const nextIndex = ((maxRows?.[0]?.day_index as number | undefined) ?? -1) + 1;

  const newId = uuid();
  const { error: wErr } = await supabase.from("planned_workouts").insert({
    id: newId,
    program_id: workout.program_id,
    day_index: nextIndex,
    label: workout.label,
    notes: workout.notes,
    plan_note: workout.plan_note,
    scheduled_date: targetDate,
  });
  throwIf(wErr);

  const { data: rx, error: rErr } = await supabase
    .from("prescriptions")
    .select(
      "exercise_id,position,sets,reps_min,reps_max,load_kg,load_pct_tm,rest_seconds,notes",
    )
    .eq("planned_workout_id", workout.id);
  throwIf(rErr);
  if (rx && rx.length > 0) {
    const { error: iErr } = await supabase
      .from("prescriptions")
      .insert(rx.map((r) => ({ ...r, id: uuid(), planned_workout_id: newId })));
    throwIf(iErr);
  }
  await invalidatePlanCaches();
  return newId;
}

export async function deletePlannedWorkout(id: string): Promise<void> {
  const { error } = await supabase
    .from("planned_workouts")
    .delete()
    .eq("id", id);
  throwIf(error);
  await invalidatePlanCaches(id);
}

export async function updatePrescription(
  id: string,
  plannedWorkoutId: string,
  patch: PrescriptionPatch,
): Promise<void> {
  const { error } = await supabase
    .from("prescriptions")
    .update(patch)
    .eq("id", id);
  throwIf(error);
  await invalidatePlanCaches(plannedWorkoutId);
}

export async function deletePrescription(
  id: string,
  plannedWorkoutId: string,
): Promise<void> {
  const { error } = await supabase.from("prescriptions").delete().eq("id", id);
  throwIf(error);
  await invalidatePlanCaches(plannedWorkoutId);
}

export async function addPrescription(
  plannedWorkoutId: string,
  exerciseId: string,
  existing: ResolvedPrescriptionRow[],
): Promise<void> {
  const position = existing.reduce((m, r) => Math.max(m, r.position), -1) + 1;
  const row: PrescriptionInsert = {
    id: uuid(),
    planned_workout_id: plannedWorkoutId,
    exercise_id: exerciseId,
    position,
    sets: 3,
    reps_min: 8,
    reps_max: 8,
    load_kg: null, // "by feel" until edited
    load_pct_tm: null,
    rest_seconds: null,
    notes: null,
  };
  const { error } = await supabase.from("prescriptions").insert(row);
  throwIf(error);
  await invalidatePlanCaches(plannedWorkoutId);
}

// ---- workout completion ----------------------------------------------------

/**
 * planned_workout_ids (of the given set) that already have a session.
 * Drives DONE / TODAY / TO COME on the Today screen.
 */
export async function getDoneWorkoutIds(
  programId: string,
  workoutIds: string[],
): Promise<{ data: string[]; fromCache: boolean }> {
  return fetchWithCache(cacheKeys.doneWorkouts(programId), async () => {
    if (workoutIds.length === 0) return [];
    const { data, error } = await supabase
      .from("sessions")
      .select("planned_workout_id")
      .is("discarded_at", null)
      .in("planned_workout_id", workoutIds);
    throwIf(error);
    const rows = (data ?? []) as Array<{ planned_workout_id: string | null }>;
    return [
      ...new Set(
        rows
          .map((r) => r.planned_workout_id)
          .filter((id): id is string => id !== null),
      ),
    ];
  });
}

// ---- prescriptions ---------------------------------------------------------

export async function getResolvedPrescriptions(
  plannedWorkoutId: string,
): Promise<{ data: ResolvedPrescriptionRow[]; fromCache: boolean }> {
  return fetchWithCache(cacheKeys.prescriptions(plannedWorkoutId), async () => {
    const { data, error } = await supabase
      .from("v_resolved_prescriptions")
      .select("*")
      .eq("planned_workout_id", plannedWorkoutId)
      .order("position");
    throwIf(error);
    return (data ?? []) as ResolvedPrescriptionRow[];
  });
}

// ---- exercises -------------------------------------------------------------

export async function getExercises(): Promise<{
  data: ExerciseRow[];
  fromCache: boolean;
}> {
  return fetchWithCache(cacheKeys.exercises, async () => {
    const { data, error } = await supabase
      .from("exercises")
      .select("id,name,equipment,primary_muscles")
      .order("name")
      .limit(2000);
    throwIf(error);
    return (data ?? []) as ExerciseRow[];
  });
}

// ---- last actuals ----------------------------------------------------------

export type LastActuals = Record<string, { load_kg: number; reps: number }>;

/**
 * Most recent working set per exercise across past sessions (fallback: most
 * recent set of any type). Used to prefill when there is no prescription.
 */
export async function getLastActuals(excludeSessionId?: string): Promise<{
  data: LastActuals;
  fromCache: boolean;
}> {
  return fetchWithCache(cacheKeys.lastActuals(excludeSessionId), async () => {
    const { data, error } = await supabase
      .from("v_live_sets")
      .select("exercise_id,load_kg,reps,set_type,performed_at,session_id")
      .order("performed_at", { ascending: false })
      .limit(1000);
    throwIf(error);
    const rows = (data ?? []) as Array<{
      exercise_id: string;
      load_kg: number;
      reps: number;
      set_type: string;
      session_id: string;
    }>;
    const best: LastActuals = {};
    const anyType: LastActuals = {};
    for (const r of rows) {
      if (excludeSessionId && r.session_id === excludeSessionId) continue;
      if (!(r.exercise_id in anyType))
        anyType[r.exercise_id] = { load_kg: r.load_kg, reps: r.reps };
      if (r.set_type === "working" && !(r.exercise_id in best))
        best[r.exercise_id] = { load_kg: r.load_kg, reps: r.reps };
    }
    return { ...anyType, ...best };
  });
}

// ---- open-session lifecycle ------------------------------------------------
// A session left open past its calendar day is finished business: on the
// next app open it auto-completes (ended_at = last set's time) or, if it
// never logged a set, auto-discards (an accidental start must not mark the
// planned workout done). Same-day open sessions this device has no cache
// for (other device, restored phone) are surfaced for adoption.

export interface OpenSessionRow {
  id: string;
  planned_workout_id: string | null;
  started_at: string;
}

export interface OpenSessionSync {
  /** sessions auto-completed this pass */
  autoCompleted: number;
  /** empty stale sessions auto-discarded this pass */
  autoDiscarded: number;
  /** the local activeSession cache pointed at a closed/discarded session */
  clearedActive: boolean;
  /** a same-day open session with no local cache (offer resume/finish) */
  orphan: OpenSessionRow | null;
}

/**
 * Reconcile open sessions with the calendar. Online-only; callers treat a
 * throw as "offline, retry on next launch". `localDayOf` maps a timestamptz
 * to the device's local calendar date; `today` is that date for now.
 */
export async function syncOpenSessions(
  activeId: string | null,
  localDayOf: (iso: string) => string,
  today: string,
  /** session ids with a QUEUED update (ended/discarded offline) — the server
   *  hasn't heard yet, so they must be neither auto-closed nor surfaced */
  pendingUpdateIds: Set<string> = new Set(),
): Promise<OpenSessionSync> {
  const { data, error } = await supabase
    .from("sessions")
    .select("id,planned_workout_id,started_at")
    .is("ended_at", null)
    .is("discarded_at", null)
    .order("started_at");
  throwIf(error);
  const open = ((data ?? []) as OpenSessionRow[]).filter(
    (s) => !pendingUpdateIds.has(s.id),
  );

  let autoCompleted = 0;
  let autoDiscarded = 0;
  let clearedActive = false;

  for (const s of open) {
    if (localDayOf(s.started_at) >= today) continue; // still today's business
    const { data: lastRows, error: lErr } = await supabase
      .from("v_live_sets")
      .select("performed_at")
      .eq("session_id", s.id)
      .order("performed_at", { ascending: false })
      .limit(1);
    throwIf(lErr);
    const last = lastRows?.[0]?.performed_at as string | undefined;
    if (last) {
      // complete at the last logged set (clamped: the DB requires
      // ended_at >= started_at)
      const endedAt = last > s.started_at ? last : s.started_at;
      const { error: uErr } = await supabase
        .from("sessions")
        .update({ ended_at: endedAt })
        .eq("id", s.id)
        .is("ended_at", null);
      throwIf(uErr);
      autoCompleted++;
    } else {
      const { error: dErr } = await supabase
        .from("sessions")
        .update({ discarded_at: new Date().toISOString() })
        .eq("id", s.id);
      throwIf(dErr);
      await cacheDeleteByPrefix(["doneWorkouts:"]);
      autoDiscarded++;
    }
    if (activeId === s.id) {
      await cacheDelete(cacheKeys.activeSession);
      clearedActive = true;
    }
  }

  // The local cache can also point at a session that was finished or
  // discarded elsewhere. A session MISSING from the server is different —
  // its insert may still be queued in the outbox — so only a row that
  // exists and is closed clears the cache.
  if (activeId !== null && !clearedActive) {
    const { data: row, error: aErr } = await supabase
      .from("sessions")
      .select("id,ended_at,discarded_at")
      .eq("id", activeId)
      .maybeSingle();
    throwIf(aErr);
    if (row && (row.ended_at !== null || row.discarded_at !== null)) {
      await cacheDelete(cacheKeys.activeSession);
      clearedActive = true;
    }
  }

  const validActive = activeId !== null && !clearedActive;
  const orphan =
    open.find(
      (s) =>
        localDayOf(s.started_at) >= today &&
        (!validActive || s.id !== activeId),
    ) ?? null;

  return { autoCompleted, autoDiscarded, clearedActive, orphan };
}

// ---- session meta (History renders the post-workout note + sRPE) -----------

export interface SessionMetaRow {
  id: string;
  session_rpe: number | null;
  notes: string | null;
}

/** Notes/sRPE for the sessions behind one exercise's history, cached under
 *  `sessionMeta:<exerciseId>` so notes read back offline too. */
export async function getSessionMeta(
  exerciseId: string,
  ids: string[],
): Promise<{ data: Record<string, SessionMetaRow>; fromCache: boolean }> {
  return fetchWithCache(`sessionMeta:${exerciseId}`, async () => {
    if (ids.length === 0) return {};
    const { data, error } = await supabase
      .from("sessions")
      .select("id,session_rpe,notes")
      .in("id", ids);
    throwIf(error);
    return Object.fromEntries(
      ((data ?? []) as SessionMetaRow[]).map((r) => [r.id, r]),
    );
  });
}

// ---- per-set notes ---------------------------------------------------------

/** Notes for a list of set ids, set_id -> note. Online; callers cache. */
export async function getSetNotesByIds(
  ids: string[],
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const { data, error } = await supabase
    .from("set_notes")
    .select("set_id,note")
    .in("set_id", ids);
  throwIf(error);
  return Object.fromEntries(
    ((data ?? []) as { set_id: string; note: string }[]).map((r) => [
      r.set_id,
      r.note,
    ]),
  );
}

/** History variant, cached under `setNotes:<exerciseId>` for offline. */
export async function getSetNotesForExercise(
  exerciseId: string,
  ids: string[],
): Promise<{ data: Record<string, string>; fromCache: boolean }> {
  return fetchWithCache(`setNotes:${exerciseId}`, () => getSetNotesByIds(ids));
}

// ---- session sets (server + cache; caller merges outbox pending) -----------

export async function getServerSessionSets(
  sessionId: string,
): Promise<SetInsert[]> {
  const key = cacheKeys.sessionSets(sessionId);
  try {
    const { data, error } = await supabase
      .from("v_live_sets")
      .select(SET_COLUMNS)
      .eq("session_id", sessionId)
      .order("performed_at");
    throwIf(error);
    const rows = (data ?? []) as SetInsert[];
    await cacheSet(key, rows);
    return rows;
  } catch (e) {
    const cached = await cacheGet<SetInsert[]>(key);
    if (cached) return cached;
    reportError(e, "load session sets");
    return [];
  }
}

/** server/cached sets + locally queued sets, deduped by id, in time order. */
export function mergeSets(
  server: SetInsert[],
  pending: SetInsert[],
): SetInsert[] {
  const byId = new Map<string, SetInsert>();
  for (const s of server) byId.set(s.id, s);
  for (const s of pending) if (!byId.has(s.id)) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) =>
    a.performed_at.localeCompare(b.performed_at),
  );
}

// ---- history ---------------------------------------------------------------

export async function getE1rmSeries(
  exerciseId: string,
): Promise<{ data: SessionBestE1rmRow[]; fromCache: boolean }> {
  return fetchWithCache(cacheKeys.e1rm(exerciseId), async () => {
    const { data, error } = await supabase
      .from("v_session_best_e1rm")
      .select("exercise_id,session_id,performed_at,best_e1rm_kg")
      .eq("exercise_id", exerciseId)
      .order("performed_at");
    throwIf(error);
    return (data ?? []) as SessionBestE1rmRow[];
  });
}

export async function getWeeklyVolume(
  exerciseId: string,
): Promise<{ data: WeeklyVolumeRow[]; fromCache: boolean }> {
  return fetchWithCache(cacheKeys.volume(exerciseId), async () => {
    const { data, error } = await supabase
      .from("v_weekly_volume")
      .select("exercise_id,week_start,working_sets,tonnage_kg")
      .eq("exercise_id", exerciseId)
      .order("week_start");
    throwIf(error);
    return (data ?? []) as WeeklyVolumeRow[];
  });
}

export async function getGoalProgress(
  exerciseId: string,
): Promise<{ data: GoalProgressRow | null; fromCache: boolean }> {
  return fetchWithCache(cacheKeys.goal(exerciseId), async () => {
    const { data, error } = await supabase
      .from("v_goal_progress")
      .select("*")
      .eq("exercise_id", exerciseId)
      .limit(1);
    throwIf(error);
    const rows = (data ?? []) as GoalProgressRow[];
    return rows[0] ?? null;
  });
}

export async function getRecentSets(
  exerciseId: string,
): Promise<{ data: SetInsert[]; fromCache: boolean }> {
  return fetchWithCache(cacheKeys.recentSets(exerciseId), async () => {
    const { data, error } = await supabase
      .from("v_live_sets")
      .select(SET_COLUMNS)
      .eq("exercise_id", exerciseId)
      .order("performed_at", { ascending: false })
      .limit(60);
    throwIf(error);
    return (data ?? []) as SetInsert[];
  });
}
