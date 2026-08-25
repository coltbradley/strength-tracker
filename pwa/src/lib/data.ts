// Read layer: online-first with IndexedDB cache fallback, so the app stays
// usable offline mid-gym. Session-critical reads (today's prescriptions,
// exercise list, last actuals) are cached; locally queued sets are merged in
// by callers so the UI reflects unsynced work.

import { supabase } from "./supabase";
import { cacheGet, cacheSet, cacheKeys } from "./db";
import { reportError } from "./errors";
import type {
  ExerciseRow,
  GoalProgressRow,
  PlannedWorkoutRow,
  ProgramRow,
  ResolvedPrescriptionRow,
  SessionBestE1rmRow,
  SetInsert,
  WeeklyVolumeRow,
} from "./types";

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

export async function getPlannedWorkouts(): Promise<{
  data: WorkoutList;
  fromCache: boolean;
}> {
  return fetchWithCache(cacheKeys.plannedWorkouts, async () => {
    const { data: programs, error: pErr } = await supabase
      .from("programs")
      .select("id,name,created_at,confirmed_at")
      .not("confirmed_at", "is", null)
      .order("created_at", { ascending: false });
    throwIf(pErr);
    const progs = (programs ?? []) as ProgramRow[];
    if (progs.length === 0) return { programs: [], workouts: [] };
    const { data: workouts, error: wErr } = await supabase
      .from("planned_workouts")
      .select("id,program_id,day_index,label,notes")
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
  return fetchWithCache(cacheKeys.lastActuals, async () => {
    const { data, error } = await supabase
      .from("sets")
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

// ---- session sets (server + cache; caller merges outbox pending) -----------

export async function getServerSessionSets(
  sessionId: string,
): Promise<SetInsert[]> {
  const key = cacheKeys.sessionSets(sessionId);
  try {
    const { data, error } = await supabase
      .from("sets")
      .select(
        "id,session_id,exercise_id,prescription_id,set_index,set_type,load_kg,reps,performed_at",
      )
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
  return fetchWithCache(`e1rm:${exerciseId}`, async () => {
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
  return fetchWithCache(`volume:${exerciseId}`, async () => {
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
  return fetchWithCache(`goal:${exerciseId}`, async () => {
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
  return fetchWithCache(`recent:${exerciseId}`, async () => {
    const { data, error } = await supabase
      .from("sets")
      .select(
        "id,session_id,exercise_id,prescription_id,set_index,set_type,load_kg,reps,performed_at",
      )
      .eq("exercise_id", exerciseId)
      .order("performed_at", { ascending: false })
      .limit(60);
    throwIf(error);
    return (data ?? []) as SetInsert[];
  });
}
