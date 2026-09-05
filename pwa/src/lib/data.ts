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
  cacheFamilies,
  cacheKeys,
} from "./db";
import { reportError } from "./errors";
import { outbox } from "./sync";
import { uuid } from "./uuid";
import { countRefreshed, refreshedLoads } from "./templateLoads";
import type {
  AdherenceRow,
  ExerciseRow,
  GoalProgressRow,
  LoadEntry,
  PlannedWorkoutPatch,
  PlannedWorkoutRow,
  PrescriptionInsert,
  PrescriptionPatch,
  ProgramRow,
  ResolvedPrescriptionRow,
  SessionBestE1rmRow,
  SetInsert,
  SetType,
  TrackingMode,
  TrainingMaxRow,
  WeeklyVolumeRow,
} from "./types";

/** Column list for every `sets` select — one place, matches SetInsert.
 *
 *  `load_entry` is load-bearing, not decorative. `load_kg` is always the TOTAL
 *  system load, so a pair of 15 kg dumbbells is stored as 30; `load_entry` is
 *  the only thing that says to render that back as "15 kg/side". Drop it from
 *  the projection and every reader falls through to treating the row as an
 *  explicit total — History then claims the lifter curled 30 kg per hand, and
 *  a prescribed-vs-achieved comparison reads a phantom overshoot, which is the
 *  exact failure the column was added to prevent. It stays NULLABLE on
 *  purpose: null is "not asserted", never "confirmed total". */
const SET_COLUMNS =
  "id,session_id,exercise_id,prescription_id,set_index,set_type,load_kg,reps,performed_at,rest_seconds_actual,load_entry";

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

// ---- cache invalidation verbs ----------------------------------------------
// Screens call these; they never name a prefix. The families are declared
// once in db.ts beside the key builders that produce them, so "did I
// invalidate the right thing" is answered by reading one place. An asymmetry
// here already cost a bug once: a finished session left the planned day
// looking unfinished because finish and discard dropped different families.

/**
 * A set was logged, voided, or left with a discarded session. Every read
 * derived from a session's SETS is now stale.
 */
export async function invalidateForSetChange(): Promise<void> {
  await cacheDeleteByPrefix(cacheFamilies.sessionDerived);
}

/**
 * A session was discarded. Everything set-derived is stale AND the week's
 * DONE state is stale.
 *
 * Finishing is deliberately NOT this: it calls `invalidateForSetChange` and
 * then PATCHES the done-workout cache instead of dropping it, because
 * dropping is a no-op offline — the refetch that would rebuild it is exactly
 * what cannot run — and the day would keep reading as unfinished. The two
 * paths must otherwise leave identical survivors; `db.test.ts` pins that.
 */
export async function invalidateForSessionClose(): Promise<void> {
  await cacheDeleteByPrefix([
    ...cacheFamilies.sessionDerived,
    ...cacheFamilies.sessionClosed,
  ]);
}

/** Postgres `restrict_violation`: a before-delete trigger refused the row. */
const RESTRICT_VIOLATION = "23001";

/**
 * The database declined an edit for a reason the PERSON can act on, as
 * opposed to a failure. Callers show `message` as ordinary guidance and do
 * not report it as an exception: it is the system working, and filing it to
 * Sentry would bury real breakage under people editing their plans.
 */
export class PlanEditRefused extends Error {
  readonly refused = true;
  constructor(message: string) {
    super(message);
    this.name = "PlanEditRefused";
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
      // A discarded program is out of the plan. v_plan_workouts already hides
      // its days; this stops the program itself heading the Today screen.
      .is("discarded_at", null)
      .order("created_at", { ascending: false });
    throwIf(pErr);
    const progs = (programs ?? []) as ProgramRow[];
    if (progs.length === 0) return { programs: [], workouts: [] };
    // v_plan_workouts, not planned_workouts: templates are dateless planned
    // days and would otherwise land in the DAY 1..N fallback list, which is
    // the one place on Today that renders days without a date.
    const { data: workouts, error: wErr } = await supabase
      .from("v_plan_workouts")
      .select(
        "id,program_id,day_index,label,notes,scheduled_date,plan_note,skipped_at,exercise_count",
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
      "exercise_id,position,sets,reps_min,reps_max,load_kg,load_pct_tm,rest_seconds,notes,superset_group",
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

/**
 * Remove a planned day from every view WITHOUT destroying what was logged
 * against it.
 *
 * This was a hard delete, and prescriptions cascade from planned_workouts
 * while `sets.prescription_id` is `on delete set null` — so deleting a day
 * permanently severed sets that had already been logged against it from the
 * plan they fulfilled. Adherence history went with them, and `sets` is
 * append-only, so nothing restored it. The plan editor reached that on the
 * ordinary edit path.
 *
 * Soft delete, same name and shape as `sessions.discarded_at` and
 * `programs.discarded_at`, so the schema has one idiom for this and not
 * three.
 */
export async function deletePlannedWorkout(id: string): Promise<void> {
  const { error } = await supabase
    .from("planned_workouts")
    .update({ discarded_at: new Date().toISOString() })
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

/**
 * Put a set of rows in one section, or take them out of every section.
 *
 * A section is not a row's private property — it is the name of a part of the
 * day, and renaming it, emptying it or moving a whole exercise into it all
 * touch several rows at once. One statement, so a section is never half
 * renamed.
 */
export async function setPrescriptionSection(
  ids: string[],
  plannedWorkoutId: string,
  section: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("prescriptions")
    .update({ section })
    .in("id", ids);
  throwIf(error);
  await invalidatePlanCaches(plannedWorkoutId);
}

/**
 * Remove ONE exercise from a planned day. Still a hard delete: a prescription
 * has no life outside its day, and giving it its own `discarded_at` would
 * make every read filter on two nullable timestamps to spare a row nobody
 * refers to.
 *
 * The gap that leaves — deleting a prescription somebody has already trained
 * against — is closed by a `before delete` trigger in the database rather
 * than by a second column. It raises `restrict_violation`, which is a
 * SITUATION and not a failure: the person is trying to edit away an exercise
 * they have logged sets against, and the thing they actually want is to
 * discard the day. Say that, rather than showing them a Postgres string.
 */
export async function deletePrescription(
  id: string,
  plannedWorkoutId: string,
): Promise<void> {
  const { error } = await supabase.from("prescriptions").delete().eq("id", id);
  if (error && (error as { code?: string }).code === RESTRICT_VIOLATION) {
    throw new PlanEditRefused(
      "You've already logged sets against this exercise, so removing it " +
        "would cut them loose from the day they belong to. Remove the whole " +
        "day instead, or leave this here — what you logged stays either way.",
    );
  }
  throwIf(error);
  await invalidatePlanCaches(plannedWorkoutId);
}

/**
 * Add an exercise to the library from the app.
 *
 * The MCP tool has always been able to do this; the person holding the phone
 * could not, so a movement the seed happens not to carry (or carries under a
 * name nobody searches for — a dumbbell lateral raise is filed as "Side
 * Lateral Raise") was simply untrackable from the gym floor.
 *
 * source = 'custom' keeps it out of the way of the generated seed, which only
 * ever updates its own rows. Ownership is claimed by an `after insert` trigger
 * from auth.uid() — this is the RLS path, so unlike the service-role MCP path
 * there is no owner row to write by hand.
 */
export async function addCustomExercise(input: {
  name: string;
  primary_muscles: string[];
  equipment: string | null;
  mechanic: "compound" | "isolation" | null;
  category: string;
}): Promise<ExerciseRow> {
  const name = input.name.trim();
  if (name.length === 0) throw new Error("An exercise needs a name");
  const id = name.replace(/[^0-9a-zA-Z]+/g, "_").replace(/^_+|_+$/g, "");
  if (id.length === 0) throw new Error("That name has no letters or numbers");

  const row = {
    id,
    name,
    primary_muscles: input.primary_muscles,
    secondary_muscles: [],
    equipment: input.equipment,
    mechanic: input.mechanic,
    force: null,
    category: input.category,
    level: "intermediate",
    source: "custom",
  };
  const { error } = await supabase.from("exercises").insert(row);
  if (error) {
    // 23505: the slug is taken. Saying which is more useful than the code,
    // because the taker is usually the thing they were looking for.
    if (error.code === "23505") {
      throw new Error(
        `"${name}" already exists in the library — search for it instead.`,
      );
    }
    throw new Error(error.message);
  }
  await cacheDelete(cacheKeys.exercises);
  return row as ExerciseRow;
}

// ---- workout templates -----------------------------------------------------
// A template is a planned day with no date and is_template set. It never
// reaches the calendar (the DB forbids a dated template, and v_plan_workouts
// drops them), and it owns prescriptions like any other day, so the plan
// editor and the MCP see one shape.

export interface TemplateRow {
  id: string;
  label: string | null;
  exercise_count: number;
}

/**
 * The saved workouts, newest first.
 *
 * Two queries rather than a `prescriptions(count)` embed: the embedded
 * aggregate is a PostgREST extension, and counting a handful of rows in JS is
 * both portable and free at this size.
 */
export async function getTemplates(): Promise<TemplateRow[]> {
  const { data, error } = await supabase
    .from("planned_workouts")
    .select("id,label")
    .eq("is_template", true)
    .order("day_index", { ascending: false });
  throwIf(error);
  const rows = (data ?? []) as { id: string; label: string | null }[];
  if (rows.length === 0) return [];

  const { data: rx, error: rxErr } = await supabase
    .from("prescriptions")
    .select("planned_workout_id")
    .in(
      "planned_workout_id",
      rows.map((r) => r.id),
    );
  throwIf(rxErr);
  const counts = new Map<string, number>();
  for (const r of (rx ?? []) as { planned_workout_id: string }[])
    counts.set(
      r.planned_workout_id,
      (counts.get(r.planned_workout_id) ?? 0) + 1,
    );

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    exercise_count: counts.get(r.id) ?? 0,
  }));
}

/**
 * Save a planned day as a reusable template: a dateless copy of the day and
 * every prescription on it.
 *
 * The copy is deliberate rather than a reference. A template you saved in
 * March should not change because you edited March's Tuesday in April, and a
 * day applied FROM a template should not follow the template afterwards.
 */
export async function saveWorkoutAsTemplate(
  workout: PlannedWorkoutRow,
  name: string,
  rx: ResolvedPrescriptionRow[],
): Promise<string> {
  const { data: maxRows, error: mErr } = await supabase
    .from("planned_workouts")
    .select("day_index")
    .eq("program_id", workout.program_id)
    .order("day_index", { ascending: false })
    .limit(1);
  throwIf(mErr);
  const dayIndex =
    ((maxRows ?? [])[0] as { day_index: number } | undefined)?.day_index ?? -1;

  const id = uuid();
  const { error } = await supabase.from("planned_workouts").insert({
    id,
    program_id: workout.program_id,
    day_index: dayIndex + 1,
    label: name,
    is_template: true,
    scheduled_date: null,
  });
  throwIf(error);

  if (rx.length > 0) {
    const rows: PrescriptionInsert[] = rx.map((r, i) => ({
      id: uuid(),
      planned_workout_id: id,
      exercise_id: r.exercise_id,
      position: i,
      sets: r.sets,
      reps_min: r.reps_min,
      reps_max: r.reps_max,
      load_kg: r.load_kg,
      load_pct_tm: r.load_pct_tm,
      rest_seconds: r.rest_seconds,
      notes: r.notes,
      set_type: r.set_type ?? "working",
    }));
    const { error: rxErr } = await supabase.from("prescriptions").insert(rows);
    throwIf(rxErr);
  }
  await invalidatePlanCaches();
  return id;
}

export interface AppliedTemplate {
  workoutId: string;
  /** exercises whose load came from a logged set rather than the template */
  refreshed: number;
  total: number;
}

/**
 * Drop a template onto a date.
 *
 * Loads come from what was LAST ACTUALLY LIFTED for each exercise, not from
 * the numbers frozen into the template. A template saved three months ago
 * would otherwise walk your strength backwards every time you used it, which
 * is the opposite of what saving a session for reuse is for.
 *
 * Two deliberate exclusions. A %TM prescription is left alone: it is already
 * relative to a training max that moves on its own, and overwriting it with an
 * absolute number would break that link. A warmup is left alone too — warmups
 * are chosen relative to the day's top set, and the last warmup you happened
 * to log is not a better guess than what the template says.
 */
export async function applyTemplate(
  templateId: string,
  programId: string,
  date: string,
  lastActuals: LastActuals,
): Promise<AppliedTemplate> {
  const { data: tpl, error: tErr } = await supabase
    .from("planned_workouts")
    .select("label")
    .eq("id", templateId)
    .single();
  throwIf(tErr);

  const { data: rxRows, error: rErr } = await supabase
    .from("prescriptions")
    .select(
      "exercise_id,position,sets,reps_min,reps_max,load_kg,load_pct_tm,rest_seconds,notes,set_type,superset_group,load_entry",
    )
    .eq("planned_workout_id", templateId)
    .order("position");
  throwIf(rErr);

  const { data: maxRows, error: mErr } = await supabase
    .from("planned_workouts")
    .select("day_index")
    .eq("program_id", programId)
    .order("day_index", { ascending: false })
    .limit(1);
  throwIf(mErr);
  const dayIndex =
    ((maxRows ?? [])[0] as { day_index: number } | undefined)?.day_index ?? -1;

  const workoutId = uuid();
  const { error: wErr } = await supabase.from("planned_workouts").insert({
    id: workoutId,
    program_id: programId,
    day_index: dayIndex + 1,
    label: (tpl as { label: string | null } | null)?.label ?? null,
    scheduled_date: date,
    is_template: false,
  });
  throwIf(wErr);

  const src = (rxRows ?? []) as unknown as (PrescriptionInsert & {
    superset_group: number | null;
    load_entry: LoadEntry | null;
    set_type: SetType;
  })[];
  // The unit of refresh is the RAMP, not the row: overwriting every row with
  // the last actual turns a 60/85/112.5 build-up into three identical sets.
  // See lib/templateLoads.ts for the rule and what it deliberately skips.
  const next = refreshedLoads(src, lastActuals);
  const refreshed = countRefreshed(next);
  const rows = src.map((r, i) => ({
    ...r,
    id: uuid(),
    planned_workout_id: workoutId,
    load_kg: next[i] ?? r.load_kg,
  }));
  if (rows.length > 0) {
    const { error: iErr } = await supabase.from("prescriptions").insert(rows);
    throwIf(iErr);
  }
  await invalidatePlanCaches(workoutId);
  return { workoutId, refreshed, total: rows.length };
}

/** Delete a saved template. Days applied from it are copies and survive. */
export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from("planned_workouts")
    .delete()
    .eq("id", id)
    .eq("is_template", true);
  throwIf(error);
  await invalidatePlanCaches();
}

/**
 * Write a whole set scheme at once: one prescription row per group, appended
 * in order.
 *
 * Groups come from the add-exercise sheet, which asks how many sets, what each
 * weighs and which are warmups, then collapses runs that agree. Consecutive
 * rows naming the same exercise are the ramp convention (CLAUDE.md), so a
 * warmup build-up into a top set is several rows here and ONE grouped entry on
 * Today — which is what the coach meant when they wrote it on the whiteboard.
 *
 * Inserted as a single statement so a day never ends up holding half a scheme.
 */
export async function addPrescriptionGroups(
  plannedWorkoutId: string,
  exerciseId: string,
  groups: {
    sets: number;
    reps_min: number;
    reps_max: number;
    load_kg: number | null;
    set_type: SetType;
    rest_seconds: number;
    superset_group: number;
    section: string | null;
    tracking: TrackingMode;
    load_entry: LoadEntry | null;
  }[],
  existing: ResolvedPrescriptionRow[],
): Promise<string | null> {
  if (groups.length === 0) return null;
  const base = existing.reduce((m, r) => Math.max(m, r.position), -1) + 1;
  const rows: PrescriptionInsert[] = groups.map((g, i) => ({
    id: uuid(),
    planned_workout_id: plannedWorkoutId,
    exercise_id: exerciseId,
    position: base + i,
    sets: g.sets,
    reps_min: g.reps_min,
    reps_max: g.reps_max,
    load_kg: g.load_kg,
    load_pct_tm: null,
    rest_seconds: g.rest_seconds,
    notes: null,
    set_type: g.set_type,
    superset_group: g.superset_group === 0 ? null : g.superset_group,
    section: g.section,
    tracking: g.tracking,
    // load_kg is the TOTAL; this says how the person typed it, so the session
    // screen can hand back "30 x 2" instead of prefilling half the weight.
    load_entry: g.load_entry,
  }));
  const { error } = await supabase.from("prescriptions").insert(rows);
  throwIf(error);
  await invalidatePlanCaches(plannedWorkoutId);
  return rows[0]!.id;
}

/**
 * Reorder a whole day at once, from a dragged order.
 *
 * `unique (planned_workout_id, position)` means positions cannot simply be
 * reassigned in place — the first UPDATE would collide with a row still
 * holding its target number. So every row parks above the range first, then
 * comes back down into its new slot. Two passes, never a collision.
 *
 * Rows whose position is already correct are skipped, so dropping a row back
 * where it came from writes nothing.
 */
export async function reorderPrescriptions(
  plannedWorkoutId: string,
  orderedIds: string[],
  existing: ResolvedPrescriptionRow[],
): Promise<void> {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const target = orderedIds
    .map((id, index) => ({ row: byId.get(id), index }))
    .filter((x): x is { row: ResolvedPrescriptionRow; index: number } =>
      Boolean(x.row),
    )
    .filter((x) => x.row.position !== x.index);
  if (target.length === 0) return;

  const park = existing.reduce((m, r) => Math.max(m, r.position), 0) + 1;
  const step = async (id: string, position: number) => {
    const { error } = await supabase
      .from("prescriptions")
      .update({ position })
      .eq("id", id);
    throwIf(error);
  };

  // Park everything that moves, then land it. Two passes, never a collision.
  for (let i = 0; i < target.length; i++) {
    await step(target[i]!.row.id, park + i);
  }
  for (const t of target) {
    await step(t.row.id, t.index);
  }
  await invalidatePlanCaches(plannedWorkoutId);
}

/**
 * Create a planned day ON A DATE and return its id.
 *
 * A day with no `scheduled_date` does not merely sort oddly, it leaves the
 * calendar entirely: the week strip disappears and Today falls back to a
 * DAY 1..N list. So everything this app creates is dated, always.
 *
 * A day needs a program. Rather than make the user invent one, this attaches
 * to their newest confirmed program and creates a plain one only when there is
 * none. That program is CONFIRMED on creation, unlike anything Claude writes:
 * the confirm step exists so a parsed or prompt-injected program cannot go
 * live unreviewed, and there is nothing to review in a day the user is
 * authoring by hand. See docs/decisions.md.
 */
export async function createPlannedWorkout(
  scheduledDate: string,
  label: string,
): Promise<string> {
  const { data: programs, error: pErr } = await supabase
    .from("programs")
    .select("id")
    .not("confirmed_at", "is", null)
    .is("discarded_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  throwIf(pErr);

  let programId = (programs ?? [])[0]?.id as string | undefined;
  if (programId === undefined) {
    const created = uuid();
    const { error } = await supabase.from("programs").insert({
      id: created,
      name: "My plan",
      source_note: "Created in the app",
      confirmed_at: new Date().toISOString(),
    });
    throwIf(error);
    programId = created;
  }

  // `unique (program_id, day_index)` — take the next free index in this program.
  const { data: siblings, error: sErr } = await supabase
    .from("planned_workouts")
    .select("day_index")
    .eq("program_id", programId)
    .order("day_index", { ascending: false })
    .limit(1);
  throwIf(sErr);
  const dayIndex = ((siblings ?? [])[0]?.day_index ?? -1) + 1;

  const id = uuid();
  const { error } = await supabase.from("planned_workouts").insert({
    id,
    program_id: programId,
    day_index: dayIndex,
    // null, never "": an empty string is not null, so `label ?? fallback`
    // would not fire and the day would render with a blank heading.
    label: label.trim().length === 0 ? null : label.trim(),
    scheduled_date: scheduledDate,
  });
  throwIf(error);
  await invalidatePlanCaches();
  return id;
}

// ---- workout completion ----------------------------------------------------

/**
 * planned_workout_ids (of the given set) that have a FINISHED session.
 * Drives DONE / TODAY / TO COME on the Today screen.
 *
 * `ended_at IS NOT NULL` is load-bearing: an open session must not mark its
 * day done. Without it the week reads as finished while you are still
 * lifting, and the day offers "Start again" next to the RESUME banner.
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
      .not("ended_at", "is", null)
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

// ---- training maxes --------------------------------------------------------
// `training_maxes` is NOT one of the four PWA-only tables (sets, sessions,
// set_voids, set_notes) and it is not session-critical, so — exactly like the
// plan editor above — these writes go straight to Supabase with a toast and
// never through the offline outbox. It is the same dual-writer class as
// programs/prescriptions: the MCP server writes it with the service role
// (set_training_max), the PWA writes it under the owner RLS policies
// (`tm_insert` / `tm_update` / `tm_delete`, 20260825120002_rls.sql:25-29).

/**
 * THE resolver for "which training max is in force". Mirrors `v_current_tm`
 * (20260825120003_views.sql:8-14): the latest `effective_date` that is not in
 * the future. Taking the newest row outright would let a value the user dated
 * for next Monday silently become today's number, and % TM prescriptions
 * would then resolve against a load nobody is lifting yet.
 *
 * `rows` may be for one exercise or many; pass a filtered list.
 */
export function currentTrainingMax(
  rows: TrainingMaxRow[],
  today: string,
): TrainingMaxRow | null {
  let best: TrainingMaxRow | null = null;
  for (const r of rows) {
    if (r.effective_date > today) continue; // scheduled, not yet in force
    if (best === null || r.effective_date > best.effective_date) best = r;
  }
  return best;
}

/** exercise_id -> that exercise's rows, newest effective_date first. */
export function groupTrainingMaxes(
  rows: TrainingMaxRow[],
): Map<string, TrainingMaxRow[]> {
  const out = new Map<string, TrainingMaxRow[]>();
  for (const r of rows) {
    const list = out.get(r.exercise_id) ?? [];
    list.push(r);
    out.set(r.exercise_id, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => b.effective_date.localeCompare(a.effective_date));
  }
  return out;
}

/** Every training max the user has ever set, newest first. */
export async function getTrainingMaxes(): Promise<{
  data: TrainingMaxRow[];
  fromCache: boolean;
}> {
  return fetchWithCache(cacheKeys.trainingMaxes, async () => {
    const { data, error } = await supabase
      .from("training_maxes")
      .select("id,exercise_id,value_kg,effective_date")
      .order("effective_date", { ascending: false });
    throwIf(error);
    // numeric(6,2) can arrive as a string from PostgREST
    return ((data ?? []) as TrainingMaxRow[]).map((r) => ({
      ...r,
      value_kg: Number(r.value_kg),
    }));
  });
}

/** Every % TM prescription the plan holds that has no TM to resolve against —
 *  the exact lifts behind a "NO TM SET" badge. Deduped, name included. */
export async function getUnresolvedTmExercises(): Promise<
  { exercise_id: string; exercise_name: string }[]
> {
  const { data, error } = await supabase
    .from("v_resolved_prescriptions")
    .select("exercise_id,exercise_name")
    .not("load_pct_tm", "is", null)
    .is("resolved_load_kg", null);
  throwIf(error);
  const seen = new Map<string, string>();
  for (const r of (data ?? []) as {
    exercise_id: string;
    exercise_name: string;
  }[]) {
    if (!seen.has(r.exercise_id)) seen.set(r.exercise_id, r.exercise_name);
  }
  return [...seen].map(([exercise_id, exercise_name]) => ({
    exercise_id,
    exercise_name,
  }));
}

/**
 * Set the training max for one exercise on one date. A new date is a NEW row
 * (the progression is the point); re-setting a date the user already used
 * replaces that row's value, which the unique constraint would otherwise
 * reject — corrections are legitimate here, unlike on `sets`.
 *
 * `id` is deliberately absent: the DB default fills it on insert, and on
 * conflict the existing row keeps its own id.
 */
export async function setTrainingMax(
  exerciseId: string,
  valueKg: number,
  effectiveDate: string,
): Promise<void> {
  const { error } = await supabase.from("training_maxes").upsert(
    {
      exercise_id: exerciseId,
      value_kg: valueKg,
      effective_date: effectiveDate,
    },
    { onConflict: "user_id,exercise_id,effective_date" },
  );
  throwIf(error);
  await invalidateTmCaches();
}

export async function deleteTrainingMax(id: string): Promise<void> {
  const { error } = await supabase.from("training_maxes").delete().eq("id", id);
  throwIf(error);
  await invalidateTmCaches();
}

/** Resolved prescriptions carry `tm_kg` / `resolved_load_kg`, so any TM write
 *  invalidates every cached prescription list as well as the TM list. */
async function invalidateTmCaches(): Promise<void> {
  await cacheDelete(cacheKeys.trainingMaxes);
  await cacheDeleteByPrefix(cacheFamilies.planResolved);
}

// ---- exercises -------------------------------------------------------------

export async function getExercises(): Promise<{
  data: ExerciseRow[];
  fromCache: boolean;
}> {
  return fetchWithCache(cacheKeys.exercises, async () => {
    const { data, error } = await supabase
      .from("exercises")
      .select("id,name,equipment")
      .order("name")
      .limit(2000);
    throwIf(error);
    return (data ?? []) as ExerciseRow[];
  });
}

// ---- last actuals ----------------------------------------------------------

/** One set as "last time" quotes it back. */
export interface LastActualSet {
  load_kg: number;
  reps: number;
}

/**
 * What an exercise was last done with.
 *
 * `load_kg`/`reps` are the TOP of the shape below — the most recent
 * qualifying set — and they are the whole of what prefill reads
 * (`prefillSet`), so they stay exactly where they were. `run` is the rest of
 * that same session, because "60 kg × 8" answers a question nobody asked:
 * what you want on the gym floor is "8, 8, 6", the shape you have to beat.
 *
 * `run` is OPTIONAL and may be absent: this record is cached in IndexedDB,
 * and a value written before the run existed carries only the two numbers.
 * Readers fall back to the top set rather than rendering nothing.
 */
export interface LastActual extends LastActualSet {
  /** the top set's session, in the order performed, newest last */
  run?: LastActualSet[];
}

export type LastActuals = Record<string, LastActual>;

/** One row of the last-actuals scan. */
export interface ActualsRow {
  exercise_id: string;
  load_kg: number;
  reps: number;
  set_type: string;
  performed_at: string;
  session_id: string;
}

/** Rows per request. Also the signal for "there may be more". */
export const ACTUALS_PAGE = 1000;
/** Safety stop: ~1M sets is far past any human training history. */
const ACTUALS_MAX_PAGES = 20;

/** How many sets of one exercise "last time" quotes. A working set count
 *  past this is a drop-set marathon nobody reads back on a phone screen;
 *  the run keeps the most RECENT six, which are the sets that mattered. */
export const LAST_RUN_CAP = 6;

/** A run being accumulated: the top set, plus which session it belongs to so
 *  everything after it can be tested against the same day. */
interface RunBuild extends LastActualSet {
  session_id: string;
  /** newest first while building — the order the pages arrive in */
  run: LastActualSet[];
}

/**
 * Fold time-descending pages of live sets into "the latest working SESSION
 * per exercise, falling back to the latest sets of any type".
 *
 * The first row seen for an exercise is its top set (the pages are newest
 * first) and it also fixes the SESSION: every later row from that same
 * session joins the run, and the first row from an older one is ignored.
 * That is what makes the answer "8, 8, 6" — one day's work — rather than a
 * rolling six sets that could straddle two workouts a fortnight apart and
 * read as a single session that never happened.
 *
 * Paging is keyset (each page asks for rows strictly older than the last row
 * of the previous page), NOT a single capped `limit`. The old single
 * 1000-row read silently truncated at roughly 35 sessions: past that, lifts
 * stopped prefilling and vanished from History's exercise index with no
 * error anywhere. `fetchPage` is injected so the walk is testable without a
 * database.
 */
export async function scanLastActuals(
  fetchPage: (cursor: string | null) => Promise<ActualsRow[]>,
  excludeSessionId?: string,
): Promise<LastActuals> {
  const best: Record<string, RunBuild> = {};
  const anyType: Record<string, RunBuild> = {};
  const add = (into: Record<string, RunBuild>, r: ActualsRow): void => {
    const cur = into[r.exercise_id];
    const one: LastActualSet = { load_kg: r.load_kg, reps: r.reps };
    if (cur === undefined) {
      into[r.exercise_id] = { ...one, session_id: r.session_id, run: [one] };
      return;
    }
    // a row from an EARLIER session is not part of this run
    if (cur.session_id !== r.session_id || cur.run.length >= LAST_RUN_CAP)
      return;
    cur.run.push(one);
  };
  let cursor: string | null = null;
  for (let page = 0; page < ACTUALS_MAX_PAGES; page++) {
    const rows = await fetchPage(cursor);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (excludeSessionId && r.session_id === excludeSessionId) continue;
      add(anyType, r);
      if (r.set_type === "working") add(best, r);
    }
    if (rows.length < ACTUALS_PAGE) break;
    const next = rows[rows.length - 1].performed_at;
    // a page that cannot advance the cursor would loop forever
    if (next === cursor) break;
    cursor = next;
  }
  // the walk is newest-first; a run is READ in the order it was performed
  const finish = (built: Record<string, RunBuild>): LastActuals =>
    Object.fromEntries(
      Object.entries(built).map(([id, b]) => [
        id,
        { load_kg: b.load_kg, reps: b.reps, run: [...b.run].reverse() },
      ]),
    );
  return { ...finish(anyType), ...finish(best) };
}

/** Rows per page of the logged-exercise scan. Same 1000 the last-actuals
 *  scan uses — a page size the deployment is known to actually receive, so
 *  "a short page means the end" stays a safe stop signal. */
const LOGGED_PAGE = ACTUALS_PAGE;

/**
 * Fold pages of exercise_id-ordered rows into the distinct ids present.
 *
 * The cursor is `exercise_id > last`, so each page jumps past the whole of
 * the id it ended on instead of walking its remaining sets — the scan is
 * bounded by how many distinct exercises exist, not by how much was lifted.
 * `fetchPage` is injected so the walk is testable without a database.
 */
export async function scanLoggedExercises(
  fetchPage: (cursor: string | null) => Promise<{ exercise_id: string }[]>,
): Promise<string[]> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < ACTUALS_MAX_PAGES; page++) {
    const rows = await fetchPage(cursor);
    if (rows.length === 0) break;
    for (const r of rows) ids.add(r.exercise_id);
    if (rows.length < LOGGED_PAGE) break;
    const next = rows[rows.length - 1].exercise_id;
    // a page that cannot advance the cursor would loop forever
    if (next === cursor) break;
    cursor = next;
  }
  return [...ids];
}

/** Put the most recently trained exercise first, the rest behind it.
 *  History opens on `[0]`, and the lift you just trained is the one you
 *  want to look at — the old full-history scan gave that ordering for free
 *  because it read in time order. */
export function orderLoggedExercises(
  ids: string[],
  mostRecent: string | null,
): string[] {
  if (mostRecent === null || !ids.includes(mostRecent)) return ids;
  return [mostRecent, ...ids.filter((id) => id !== mostRecent)];
}

/**
 * Which exercises have at least one live logged set — History's index, and
 * nothing more, most recently trained first.
 *
 * History used to answer this with `getLastActuals()`, which carries
 * load/reps/type/time/session for every set ever logged and then keeps only
 * `Object.keys()`. PostgREST has no DISTINCT and Supabase ships with
 * aggregate functions disabled, so the cheapest exact answer is a
 * single-column scan whose cursor skips duplicates, plus one tiny read for
 * the default selection — issued in parallel, so it costs no extra latency.
 */
export async function getLoggedExerciseIds(): Promise<{
  data: string[];
  fromCache: boolean;
}> {
  return fetchWithCache(cacheKeys.loggedExercises, async () => {
    const [ids, mostRecent] = await Promise.all([
      scanLoggedExercises(async (cursor) => {
        let q = supabase
          .from("v_live_sets")
          .select("exercise_id")
          .order("exercise_id")
          .limit(LOGGED_PAGE);
        if (cursor !== null) q = q.gt("exercise_id", cursor);
        const { data, error } = await q;
        throwIf(error);
        return (data ?? []) as { exercise_id: string }[];
      }),
      (async () => {
        const { data, error } = await supabase
          .from("v_live_sets")
          .select("exercise_id")
          .order("performed_at", { ascending: false })
          .limit(1);
        throwIf(error);
        return (data?.[0]?.exercise_id as string | undefined) ?? null;
      })(),
    ]);
    return orderLoggedExercises(ids, mostRecent);
  });
}

/**
 * Most recent working set per exercise across past sessions (fallback: most
 * recent set of any type). Used to prefill when there is no prescription.
 */
export async function getLastActuals(excludeSessionId?: string): Promise<{
  data: LastActuals;
  fromCache: boolean;
}> {
  return fetchWithCache(cacheKeys.lastActuals(excludeSessionId), () =>
    scanLastActuals(async (cursor) => {
      let q = supabase
        .from("v_live_sets")
        .select("exercise_id,load_kg,reps,set_type,performed_at,session_id")
        .order("performed_at", { ascending: false })
        .limit(ACTUALS_PAGE);
      // strict `lt` can skip rows sharing the boundary timestamp to the
      // millisecond; `lte` would re-read the boundary row forever instead
      if (cursor !== null) q = q.lt("performed_at", cursor);
      const { data, error } = await q;
      throwIf(error);
      return (data ?? []) as ActualsRow[];
    }, excludeSessionId),
  );
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

/** Closed state of one session row, as the server has it. */
export interface SessionClosedState {
  ended_at: string | null;
  discarded_at: string | null;
}

/**
 * The four server operations the reconciliation needs. Injected the way
 * `scanLastActuals` takes `fetchPage`, so the auto-complete / auto-discard /
 * stale-pointer / orphan matrix is a table test with no database. The
 * default binds these to Supabase and is the only thing here that knows
 * about PostgREST.
 */
export interface OpenSessionPort {
  /** open (not ended, not discarded) sessions, oldest first */
  listOpen(): Promise<OpenSessionRow[]>;
  /** when the session's newest live set was performed, or null if it has none */
  lastSetAt(sessionId: string): Promise<string | null>;
  /** close a session that is still open (no-op if it closed meanwhile) */
  complete(sessionId: string, endedAt: string): Promise<void>;
  discard(sessionId: string, discardedAt: string): Promise<void>;
  /** null when the server has never seen the row — its insert may still be
   *  queued in the outbox, which is NOT the same as "closed" */
  closedState(sessionId: string): Promise<SessionClosedState | null>;
  /** how many of this session's sets are still queued on THIS device.
   *  Local on purpose. Everything else on this port asks the server, but
   *  "this session has no sets" is the fact that decides whether a day of
   *  training gets discarded, and the server cannot see what has not
   *  finished uploading. */
  queuedSetCount(sessionId: string): Promise<number>;
}

const supabaseOpenSessions: OpenSessionPort = {
  async listOpen() {
    const { data, error } = await supabase
      .from("sessions")
      .select("id,planned_workout_id,started_at")
      .is("ended_at", null)
      .is("discarded_at", null)
      .order("started_at");
    throwIf(error);
    return (data ?? []) as OpenSessionRow[];
  },
  async lastSetAt(sessionId) {
    const { data, error } = await supabase
      .from("v_live_sets")
      .select("performed_at")
      .eq("session_id", sessionId)
      .order("performed_at", { ascending: false })
      .limit(1);
    throwIf(error);
    return (data?.[0]?.performed_at as string | undefined) ?? null;
  },
  async complete(sessionId, endedAt) {
    const { error } = await supabase
      .from("sessions")
      .update({ ended_at: endedAt })
      .eq("id", sessionId)
      .is("ended_at", null);
    throwIf(error);
  },
  async discard(sessionId, discardedAt) {
    const { error } = await supabase
      .from("sessions")
      .update({ discarded_at: discardedAt })
      .eq("id", sessionId);
    throwIf(error);
  },
  async closedState(sessionId) {
    const { data, error } = await supabase
      .from("sessions")
      .select("id,ended_at,discarded_at")
      .eq("id", sessionId)
      .maybeSingle();
    throwIf(error);
    return (data as SessionClosedState | null) ?? null;
  },
  async queuedSetCount(sessionId) {
    return (await outbox.pendingSets(sessionId)).length;
  },
};

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
  port: OpenSessionPort = supabaseOpenSessions,
): Promise<OpenSessionSync> {
  const open = (await port.listOpen()).filter(
    (s) => !pendingUpdateIds.has(s.id),
  );

  let autoCompleted = 0;
  let autoDiscarded = 0;
  let clearedActive = false;

  for (const s of open) {
    if (localDayOf(s.started_at) >= today) continue; // still today's business
    // Sets for this session still sitting in this device's outbox mean the
    // server's answer is not the whole truth, so leave the session entirely
    // alone — neither branch below is safe. Completing it would stamp
    // ended_at at a server-known time that is earlier than the real last
    // set; discarding it would soft-delete a workout that is mid-upload,
    // and the queued sets would then land in a session no view will ever
    // show, with no un-discard anywhere in the PWA. Next launch reconciles
    // it, by which point the flush has either gone through or the item is
    // visibly dead in the outbox.
    if ((await port.queuedSetCount(s.id)) > 0) continue;
    const last = await port.lastSetAt(s.id);
    if (last) {
      // complete at the last logged set (clamped: the DB requires
      // ended_at >= started_at)
      // Completing is safe from ANY device: sets that arrive afterwards still
      // belong to this session, and ended_at only says the day is over.
      await port.complete(s.id, last > s.started_at ? last : s.started_at);
      autoCompleted++;
    } else if (s.id === activeId) {
      // Only the device that STARTED the session may discard it. Both
      // "empty" signals above are local truths dressed as global ones:
      // `queuedSetCount` reads THIS device's outbox and `lastSetAt` reads a
      // server that has not heard from the other phone yet. On a second
      // device they both say zero for a session that logged 25 sets at the
      // gym last night and is still waiting for signal — and discarding
      // there is unrecoverable, because the queued sets then flush into a
      // session `v_live_sets` excludes and the PWA has no un-discard.
      // Owning the active pointer is the one piece of evidence that the
      // absent outbox is OUR absent outbox.
      await port.discard(s.id, new Date().toISOString());
      await cacheDeleteByPrefix(cacheFamilies.sessionClosed);
      autoDiscarded++;
    } else {
      // Someone else's open session that looks empty from here. Leave it
      // OPEN: its own device will either flush its sets (after which any
      // device auto-completes it) or discard it there. An open session left
      // open is a card on Today; a wrongly discarded one is training that
      // only SQL can find again.
      continue;
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
    const row = await port.closedState(activeId);
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
  /** Optional because sessions cached before History read it back simply
   *  carry no bodyweight field; treat undefined as "not recorded". */
  bodyweight_kg?: number | null;
}

/** Notes/sRPE/bodyweight for the sessions behind one exercise's history,
 *  cached under `sessionMeta:<exerciseId>` so they read back offline too. */
export async function getSessionMeta(
  exerciseId: string,
  ids: string[],
): Promise<{ data: Record<string, SessionMetaRow>; fromCache: boolean }> {
  return fetchWithCache(cacheKeys.sessionMeta(exerciseId), async () => {
    if (ids.length === 0) return {};
    const { data, error } = await supabase
      .from("sessions")
      .select("id,session_rpe,notes,bodyweight_kg")
      .in("id", ids);
    throwIf(error);
    return Object.fromEntries(
      ((data ?? []) as SessionMetaRow[]).map((r) => [
        r.id,
        {
          ...r,
          bodyweight_kg:
            r.bodyweight_kg == null ? null : Number(r.bodyweight_kg),
        },
      ]),
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
  return fetchWithCache(cacheKeys.setNotes(exerciseId), () =>
    getSetNotesByIds(ids),
  );
}

// ---- session sets (server + cache; caller merges outbox pending) -----------

/** No session has this many sets; the cap only bounds a pathological read. */
const SESSION_SET_CAP = 500;

/**
 * Authoritative count of a session's live (non-voided) sets, straight from
 * the server. THROWS when the server cannot be reached — a caller must treat
 * that as "unknown", never as zero: End offers "Discard empty session" as
 * its primary action off this number, and a wrong zero discards real work.
 */
export async function countServerSessionSets(
  sessionId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("v_live_sets")
    .select("id")
    .eq("session_id", sessionId)
    .limit(SESSION_SET_CAP);
  throwIf(error);
  return (data ?? []).length;
}

/**
 * How many sets a finishing session has, and whether we actually know.
 *
 * A local count above zero is proof of work on its own. A local ZERO is not
 * proof of an empty session: the device cache is empty in exactly the case
 * that matters (an adopted orphan whose best-effort server fetch failed), so
 * only a server that answers can confirm emptiness.
 */
export interface SessionSetCount {
  count: number;
  /** false = the emptiness could not be confirmed; do not offer Discard */
  authoritative: boolean;
}

export function resolveSessionSetCount(
  local: number,
  server: number | null,
): SessionSetCount {
  if (local > 0) return { count: local, authoritative: true };
  if (server === null) return { count: 0, authoritative: false };
  return { count: server, authoritative: true };
}

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

// ---- adherence (prescribed vs achieved) ------------------------------------

/** v_adherence rows plus the SET COUNT each prescription asked for, which the
 *  view does not carry (it is one row per LOGGED set, not per planned set). */
export interface AdherenceBundle {
  rows: AdherenceRow[];
  /** prescription_id -> prescriptions.sets; absent if the row is gone */
  plannedSets: Record<string, number>;
}

/**
 * What was prescribed for the sets already on screen. Scoped to the session
 * ids History is showing rather than the whole training record, so the read
 * stays proportional to what is rendered.
 */
export async function getAdherence(
  exerciseId: string,
  sessionIds: string[],
): Promise<{ data: AdherenceBundle; fromCache: boolean }> {
  return fetchWithCache(cacheKeys.adherence(exerciseId), async () => {
    if (sessionIds.length === 0) return { rows: [], plannedSets: {} };
    const { data, error } = await supabase
      .from("v_adherence")
      .select(
        "set_id,session_id,exercise_id,prescription_id,set_index,performed_at,actual_load_kg,actual_reps,reps_min,reps_max,prescribed_load_kg,load_delta_kg,rep_outcome,actual_load_entry,prescribed_load_entry",
      )
      .eq("exercise_id", exerciseId)
      .in("session_id", sessionIds);
    throwIf(error);
    const rows = ((data ?? []) as AdherenceRow[]).map((r) => ({
      ...r,
      actual_load_kg: Number(r.actual_load_kg),
      prescribed_load_kg:
        r.prescribed_load_kg == null ? null : Number(r.prescribed_load_kg),
      load_delta_kg: r.load_delta_kg == null ? null : Number(r.load_delta_kg),
    }));
    const rxIds = [...new Set(rows.map((r) => r.prescription_id))];
    const plannedSets: Record<string, number> = {};
    if (rxIds.length > 0) {
      const { data: rx, error: rErr } = await supabase
        .from("prescriptions")
        .select("id,sets")
        .in("id", rxIds);
      throwIf(rErr);
      for (const p of (rx ?? []) as { id: string; sets: number }[]) {
        plannedSets[p.id] = Number(p.sets);
      }
    }
    return { rows, plannedSets };
  });
}

/** One prescription as it played out in one session. */
export interface RxOutcome {
  prescriptionId: string;
  repsMin: number;
  repsMax: number;
  prescribedLoadKg: number | null;
  prescribedEntry: LoadEntry | null;
  /** what the plan asked for; null when the prescription has since gone */
  plannedSets: number | null;
  loggedSets: number;
  /** the set_index the first set against this prescription carried */
  firstIndex: number;
  /**
   * One side of the comparison says "per side" and the other says nothing at
   * all. `load_kg` is the total by convention, but a NULL entry mode is an
   * ABSENT assertion, not a total — so those two numbers may be on different
   * scales and the app must not imply otherwise.
   */
  entryAmbiguous: boolean;
}

/**
 * Fold v_adherence into "per session, what each prescription asked for and
 * how many sets answered it". Pure, so the honesty rules above are testable
 * without a database.
 */
export function summariseAdherence(
  bundle: AdherenceBundle,
): Map<string, RxOutcome[]> {
  const bySession = new Map<string, Map<string, RxOutcome>>();
  for (const r of bundle.rows) {
    const perRx = bySession.get(r.session_id) ?? new Map<string, RxOutcome>();
    bySession.set(r.session_id, perRx);
    const cur = perRx.get(r.prescription_id);
    // an entry mode of null is UNKNOWN; only a per_side claim facing an
    // unasserted counterpart makes the two loads incomparable
    const ambiguous =
      (r.prescribed_load_entry === "per_side" &&
        r.actual_load_entry === null) ||
      (r.prescribed_load_entry === null && r.actual_load_entry === "per_side");
    if (cur === undefined) {
      perRx.set(r.prescription_id, {
        prescriptionId: r.prescription_id,
        repsMin: r.reps_min,
        repsMax: r.reps_max,
        prescribedLoadKg: r.prescribed_load_kg,
        prescribedEntry: r.prescribed_load_entry,
        plannedSets: bundle.plannedSets[r.prescription_id] ?? null,
        loggedSets: 1,
        firstIndex: r.set_index,
        entryAmbiguous: ambiguous,
      });
    } else {
      cur.loggedSets += 1;
      cur.firstIndex = Math.min(cur.firstIndex, r.set_index);
      cur.entryAmbiguous = cur.entryAmbiguous || ambiguous;
    }
  }
  const out = new Map<string, RxOutcome[]>();
  for (const [sessionId, perRx] of bySession) {
    out.set(
      sessionId,
      [...perRx.values()].sort((a, b) => a.firstIndex - b.firstIndex),
    );
  }
  return out;
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
