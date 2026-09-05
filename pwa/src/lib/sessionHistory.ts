// History by DAY rather than by movement, plus the week in one line.
//
// Everything else in History is organised by EXERCISE: pick a lift, see its
// e1RM, its volume, its recent sets. "What did I actually do on Tuesday" was
// unanswerable in the app, and the only way to get it was to ask the coach —
// a round trip and a bill for a question the database answers directly.
//
// Read conventions are data.ts's, deliberately: online-first with an
// IndexedDB fallback so the screen survives a basement gym, PostgREST errors
// rethrown rather than swallowed, and every set-derived read going through
// `v_live_sets` so a voided set is gone before the client ever sees it.
//
// This lives outside data.ts only because another agent holds that file this
// round. It follows its neighbour's rules; it does not invent new ones.

import { supabase } from "./supabase";
import { cacheGet, cacheSet } from "./db";
import { parseLocalDate, todayLocalIso, workoutName } from "./format";
import { toDisplay, type Unit } from "./units";
import type { SetInsert } from "./types";

/**
 * Cache keys are literals here rather than entries in `db.ts`'s `cacheKeys`
 * vocabulary, and they join no invalidation family. That is a smaller
 * compromise than it looks: `fetchWithCache` is online-FIRST, so a stale
 * entry is only ever read when the network is unreachable — and the two
 * things that would stale it (a void, a discard) are exactly the things the
 * outbox is still holding at that moment, which `liveFinishedSessions` and
 * `liveSets` below subtract from the cached answer. An invalidation verb
 * would drop a cache offline and have nothing to rebuild it with.
 */
const KEY_SESSION_LOG = "sessionLog";
const keyWeekSummary = (weekStart: string) => `weekSummary:${weekStart}`;

/** How many finished sessions the log shows. History is a record, not an
 *  archive: past this you want the export or the coach. */
export const SESSION_LOG_LIMIT = 20;

/** No twenty sessions hold this many sets between them; the cap only bounds
 *  a pathological read, the way `SESSION_SET_CAP` does in data.ts. */
const SESSION_LOG_SET_CAP = 2000;

/** Mirror of `data.ts`'s private helper — online first, cache on failure,
 *  rethrow when there is no cache either. Copied rather than imported
 *  because it is not exported; the semantics must not drift. */
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

// ---- the session log -------------------------------------------------------

/** A `sessions` row as the log reads it, before anything is resolved. */
export interface RawSessionRow {
  id: string;
  started_at: string;
  /** null = OPEN. Someone is mid-workout, or a start was abandoned. */
  ended_at: string | null;
  discarded_at?: string | null;
  session_rpe: number | null;
  planned_workout_id: string | null;
}

/** One finished session: `ended_at` is non-null by construction. */
export interface FinishedSessionRow extends RawSessionRow {
  ended_at: string;
}

/** A finished session with everything the row on screen needs. */
export interface SessionLogEntry {
  id: string;
  started_at: string;
  ended_at: string;
  session_rpe: number | null;
  /** what the plan called that day; null when nothing was planned */
  label: string | null;
  /** live sets logged that day, across every exercise */
  setCount: number;
}

/**
 * Finished, undiscarded sessions — the server's answer minus what this
 * device has queued but not yet flushed.
 *
 * Two of the three filters are also `.is()` / `.not()` clauses on the query,
 * and that is not redundancy: the cached copy this falls back to offline was
 * fetched BEFORE the discard was queued, so the server-side filter has never
 * seen it. History's exercise view already subtracts the outbox from
 * `v_live_sets` for exactly this reason.
 *
 * An OPEN session is dropped outright rather than shown with a badge. It is
 * not a completed workout — the same rule that stops an open session marking
 * its planned day DONE — and Today already owns the affordance for one (the
 * RESUME banner, or the orphan card). Showing it here would also put a
 * session in the list that the weekly line beside it does not count, and two
 * numbers on one screen disagreeing about how much you trained is worse than
 * a session you have to go to Today to find.
 */
export function liveFinishedSessions(
  rows: readonly RawSessionRow[],
  pendingDiscards: ReadonlySet<string>,
): FinishedSessionRow[] {
  return rows.filter(
    (r): r is FinishedSessionRow =>
      r.ended_at !== null &&
      (r.discarded_at ?? null) === null &&
      !pendingDiscards.has(r.id),
  );
}

/**
 * Sets minus the voids this device has queued. The server half is
 * `v_live_sets`, which drops voided sets and discarded sessions before they
 * are ever selected; this is the offline delta, and the same subtraction
 * History already does for the per-exercise list.
 */
export function liveSets(
  rows: readonly SetInsert[],
  pendingVoids: ReadonlySet<string>,
): SetInsert[] {
  return rows.filter((s) => !pendingVoids.has(s.id));
}

/** One run of consecutive sets of the same movement. */
export interface SetRun {
  exerciseId: string;
  sets: SetInsert[];
}

/**
 * The day's sets, grouped into runs of the same exercise.
 *
 * CONSECUTIVE runs, not one bucket per movement. A superset really did
 * alternate A/B/A/B, and gathering it into "all the rows, then all the
 * presses" would render an order that never happened — the same reason the
 * plan expresses supersets as adjacency rather than as a grouping column.
 */
export function groupSetsByExercise(sets: readonly SetInsert[]): SetRun[] {
  const runs: SetRun[] = [];
  for (const s of sets) {
    const last = runs[runs.length - 1];
    if (last && last.exerciseId === s.exercise_id) last.sets.push(s);
    else runs.push({ exerciseId: s.exercise_id, sets: [s] });
  }
  return runs;
}

/** Wall-clock length in seconds, or null when the arithmetic cannot be
 *  trusted (a clock change, a corrupt cache). End suppresses the figure in
 *  that case rather than showing a wrong one; so does this. */
export function sessionSeconds(row: {
  started_at: string;
  ended_at: string;
}): number | null {
  const from = Date.parse(row.started_at);
  const to = Date.parse(row.ended_at);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const seconds = (to - from) / 1000;
  return seconds >= 0 ? seconds : null;
}

/**
 * The last {@link SESSION_LOG_LIMIT} finished sessions, newest first, each
 * with its planned day's label and its live set count.
 *
 * Three reads, not one. The labels come from `v_plan_workouts` because every
 * plan read goes through that view — it is what drops templates and the days
 * of a discarded program, and a filter you have to remember at the call site
 * is one someone will forget. The counts come from `v_live_sets` in a single
 * one-column scan across all twenty sessions rather than twenty per-session
 * reads; the sets THEMSELVES are still loaded one session at a time, by
 * `getServerSessionSets`, only when a row is opened.
 *
 * `pendingDiscards` is subtracted TWICE and both are load-bearing: once
 * inside the fetcher, so a session on its way out does not cost a label and
 * a count read, and once on the way out, because the cached list the offline
 * branch returns was written before the discard was ever queued.
 */
export async function getSessionLog(
  pendingDiscards: ReadonlySet<string> = new Set(),
): Promise<{
  data: SessionLogEntry[];
  fromCache: boolean;
}> {
  const res = await fetchWithCache(KEY_SESSION_LOG, async () => {
    const { data: rows, error } = await supabase
      .from("sessions")
      .select(
        "id,started_at,ended_at,discarded_at,session_rpe,planned_workout_id",
      )
      .is("discarded_at", null)
      .not("ended_at", "is", null)
      // started_at alone is not unique; id breaks the tie so the order is
      // stable between reads and the list does not shuffle under a tap
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SESSION_LOG_LIMIT);
    throwIf(error);
    const sessions = liveFinishedSessions(
      (rows ?? []) as RawSessionRow[],
      pendingDiscards,
    );
    if (sessions.length === 0) return [];

    const ids = sessions.map((s) => s.id);
    const dayIds = [
      ...new Set(
        sessions
          .map((s) => s.planned_workout_id)
          .filter((id): id is string => id !== null),
      ),
    ];

    const [labels, counts] = await Promise.all([
      (async () => {
        if (dayIds.length === 0) return new Map<string, string>();
        const { data, error: dErr } = await supabase
          .from("v_plan_workouts")
          .select("id,label,day_index")
          .in("id", dayIds);
        throwIf(dErr);
        const rowsD = (data ?? []) as Array<{
          id: string;
          label: string | null;
          day_index: number;
        }>;
        return new Map(rowsD.map((d) => [d.id, workoutName(d)]));
      })(),
      (async () => {
        const { data, error: cErr } = await supabase
          .from("v_live_sets")
          .select("session_id")
          .in("session_id", ids)
          .limit(SESSION_LOG_SET_CAP);
        throwIf(cErr);
        const tally = new Map<string, number>();
        for (const r of (data ?? []) as Array<{ session_id: string }>)
          tally.set(r.session_id, (tally.get(r.session_id) ?? 0) + 1);
        return tally;
      })(),
    ]);

    return sessions.map((s) => ({
      id: s.id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      session_rpe: s.session_rpe,
      label:
        s.planned_workout_id === null
          ? null
          : (labels.get(s.planned_workout_id) ?? null),
      setCount: counts.get(s.id) ?? 0,
    }));
  });
  return {
    data: res.data.filter((s) => !pendingDiscards.has(s.id)),
    fromCache: res.fromCache,
  };
}

// ---- the week --------------------------------------------------------------

/** One `v_weekly_summary` row. Typed here rather than in `types.ts` because
 *  another agent holds that file this round; it belongs there eventually. */
export interface WeeklySummaryRow {
  week_start: string;
  sessions: number;
  working_sets: number;
  tonnage_kg: number;
  avg_session_rpe: number | null;
  planned_days: number;
  planned_days_done: number;
}

/**
 * The Monday of the week containing `iso`, as a local calendar date.
 *
 * Monday, always, regardless of the `weekStartsOn` setting Today's strip
 * honours: the view buckets with `date_trunc('week', ...)`, which is ISO and
 * therefore Monday, and a client that asked for a Sunday-start week would be
 * looking up a `week_start` no row has. The setting moves a display grid; it
 * cannot move a key.
 */
export function weekStartIso(iso: string): string {
  const d = parseLocalDate(iso);
  const fromMonday = (d.getDay() + 6) % 7; // 0 = Monday
  return todayLocalIso(
    new Date(d.getFullYear(), d.getMonth(), d.getDate() - fromMonday),
  );
}

/** The summary row for one week, or null when the person has neither trained
 *  nor planned anything in it. */
export async function getWeeklySummary(weekStart: string): Promise<{
  data: WeeklySummaryRow | null;
  fromCache: boolean;
}> {
  return fetchWithCache(keyWeekSummary(weekStart), async () => {
    const { data, error } = await supabase
      .from("v_weekly_summary")
      .select(
        "week_start,sessions,working_sets,tonnage_kg,avg_session_rpe,planned_days,planned_days_done",
      )
      .eq("week_start", weekStart)
      .limit(1);
    throwIf(error);
    const rows = (data ?? []) as WeeklySummaryRow[];
    const row = rows[0];
    if (row === undefined) return null;
    // numerics arrive as strings over PostgREST often enough that every other
    // reader in this app coerces them; tonnage is summed, so a string here
    // would concatenate rather than add anywhere downstream
    return {
      ...row,
      tonnage_kg: Number(row.tonnage_kg),
      avg_session_rpe:
        row.avg_session_rpe === null ? null : Number(row.avg_session_rpe),
    };
  });
}

/** The week, as two strings and a flag. */
export interface WeekLineText {
  /** what was trained, or the sentence that says nothing was */
  effort: string;
  /** "4 PLANNED · 3 DONE", or null when nothing was asked for */
  plan: string | null;
  /** nothing trained AND nothing planned: the week has not started */
  idle: boolean;
}

/**
 * The weekly line in words.
 *
 * Planned and done stay TWO COUNTS, never a percentage, and the view's own
 * comment says why: a week with no plan has no adherence, and a ratio renders
 * that as 0%, which reads as total failure instead of "nothing was asked".
 * So a week with no plan prints no plan clause at all — not "0 PLANNED",
 * which is the same lie with an extra step.
 */
export function describeWeek(
  row: WeeklySummaryRow | null,
  unit: Unit,
): WeekLineText {
  const sessions = row?.sessions ?? 0;
  const workingSets = row?.working_sets ?? 0;
  const tonnage = row?.tonnage_kg ?? 0;
  const plannedDays = row?.planned_days ?? 0;

  const plan =
    plannedDays === 0
      ? null
      : `${plannedDays} PLANNED · ${row?.planned_days_done ?? 0} DONE`;

  // Nothing trained. With a plan beside it that is a fact worth stating
  // plainly; with no plan it is a week that simply has not started, and the
  // caller renders the quieter empty state instead.
  if (sessions === 0 && workingSets === 0)
    return { effort: "Nothing logged yet.", plan, idle: plan === null };

  const parts = [
    `${sessions} ${sessions === 1 ? "SESSION" : "SESSIONS"}`,
    `${workingSets} ${workingSets === 1 ? "WORKING SET" : "WORKING SETS"}`,
  ];
  // tonnage is a headline figure, not a measurement: a rounded whole number
  // with thousands separators, the way the volume chart's head already
  // renders it. Zero is omitted rather than printed, because a week of
  // bodyweight and mobility work genuinely moved no load.
  if (tonnage > 0)
    parts.push(
      `${Math.round(toDisplay(tonnage, unit)).toLocaleString()} ${unit.toUpperCase()}`,
    );
  return { effort: parts.join(" · "), plan, idle: false };
}
