// The Record list: which exercises to show and in what order.
//
// Pure functions only. The reads live in data.ts and every number here is
// handed in from a SQL view (v_live_sets for dates and counts,
// v_session_best_e1rm for the e1RM, v_goal_progress for goals), so nothing in
// this file derives a metric. It orders and slices rows, nothing else.
//
// ORDER: most recently performed calendar day first. "Most done" breaks a
// tie: the number of distinct SESSIONS that included the exercise in the last
// RECENT_WINDOW_DAYS days (a session count, not a set count, so one long
// back-off ladder does not outrank an exercise trained more often). Name is
// the final, stable tie-break. Because the primary key is the DAY, every
// exercise from today's session ties, and the one you train most floats up.
//
// PINNED = a row in `goals` exists for the exercise. There is no separate
// pinned flag: a goal is an exercise with a target e1RM, and pinning is
// having one (docs/decisions.md 2026-10-01).

import type { GoalProgressRow } from "./types";
import type { Unit } from "./units";
import { fromDisplay, toDisplay } from "./units";

export const RECENT_WINDOW_DAYS = 90;

export interface RecordSetRow {
  exercise_id: string;
  session_id: string;
  performed_at: string;
}

export interface RecordE1rmRow {
  exercise_id: string;
  session_id: string;
  performed_at: string;
  best_e1rm_kg: number;
}

/** What the list reads: dates and counts per exercise, plus the newest e1RM. */
export interface RecordIndexEntry {
  exerciseId: string;
  /** ISO instant of the newest live set */
  lastAt: string;
  /** distinct sessions in the last RECENT_WINDOW_DAYS days */
  recentSessions: number;
  /** best e1RM of the newest session that has one, null if none (1-8 reps) */
  e1rmKg: number | null;
}

export interface RecordRow extends RecordIndexEntry {
  name: string;
  goal: GoalProgressRow | null;
}

export function buildRecordIndex(
  sets: RecordSetRow[],
  e1rms: RecordE1rmRow[],
  now: Date = new Date(),
): RecordIndexEntry[] {
  const cutoff = now.getTime() - RECENT_WINDOW_DAYS * 86_400_000;
  const by = new Map<
    string,
    { lastAt: string; sessions: Set<string>; e1: RecordE1rmRow | null }
  >();
  for (const s of sets) {
    const cur = by.get(s.exercise_id) ?? {
      lastAt: s.performed_at,
      sessions: new Set<string>(),
      e1: null,
    };
    if (s.performed_at > cur.lastAt) cur.lastAt = s.performed_at;
    if (new Date(s.performed_at).getTime() >= cutoff)
      cur.sessions.add(s.session_id);
    by.set(s.exercise_id, cur);
  }
  for (const r of e1rms) {
    const cur = by.get(r.exercise_id);
    if (cur && (cur.e1 === null || r.performed_at > cur.e1.performed_at))
      cur.e1 = r;
  }
  return [...by.entries()].map(([exerciseId, v]) => ({
    exerciseId,
    lastAt: v.lastAt,
    recentSessions: v.sessions.size,
    e1rmKg: v.e1?.best_e1rm_kg ?? null,
  }));
}

/** Local calendar day of an instant, YYYY-MM-DD. */
function localDay(iso: string): string {
  if (iso === "") return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function compareRecent(a: RecordRow, b: RecordRow): number {
  const da = localDay(a.lastAt);
  const db = localDay(b.lastAt);
  if (da !== db) return da < db ? 1 : -1;
  if (a.recentSessions !== b.recentSessions)
    return b.recentSessions - a.recentSessions;
  return a.name.localeCompare(b.name);
}

export interface RecordLists {
  pinned: RecordRow[];
  recent: RecordRow[];
}

/**
 * Joins the index to names and goals, filters by search, and splits into the
 * two sections. A pinned exercise appears ONLY in PINNED (it is not repeated
 * under RECENT). A goal on an exercise with no logged sets still shows, with
 * lastAt "" so it sorts after anything performed.
 */
export function buildRecordLists(
  index: RecordIndexEntry[],
  goals: GoalProgressRow[],
  nameOf: (id: string) => string,
  search: string,
): RecordLists {
  const goalBy = new Map(goals.map((g) => [g.exercise_id, g]));
  const seen = new Set<string>();
  const rows: RecordRow[] = [];
  for (const e of index) {
    seen.add(e.exerciseId);
    rows.push({
      ...e,
      name: nameOf(e.exerciseId),
      goal: goalBy.get(e.exerciseId) ?? null,
    });
  }
  for (const g of goals) {
    if (seen.has(g.exercise_id)) continue;
    rows.push({
      exerciseId: g.exercise_id,
      lastAt: "",
      recentSessions: 0,
      e1rmKg: g.alltime_best_e1rm_kg,
      name: nameOf(g.exercise_id),
      goal: g,
    });
  }
  const q = search.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  shown.sort(compareRecent);
  return {
    pinned: shown.filter((r) => r.goal !== null),
    recent: shown.filter((r) => r.goal === null),
  };
}

// ---- goal targets ----------------------------------------------------------

/** One -/+ tap on a goal: 2.5 kg or 5 lb, whichever the lifter reads. */
export function goalStep(unit: Unit): number {
  return unit === "kg" ? 2.5 : 5;
}

/** A target is stored in kg but stepped in the display unit. */
export function stepGoalKg(currentKg: number, dir: 1 | -1, unit: Unit): number {
  const step = goalStep(unit);
  const next = Math.max(step, toDisplay(currentKg, unit) + dir * step);
  return Math.round(fromDisplay(next, unit) * 100) / 100;
}

/** First target when pinning: the current e1RM plus about 5%, rounded UP to
 *  the next step so it is always strictly above where the lifter is now. */
export function defaultGoalKg(e1rmKg: number, unit: Unit): number {
  const step = goalStep(unit);
  const shown = toDisplay(e1rmKg * 1.05, unit);
  const up = Math.max(Math.ceil(shown / step) * step, toDisplay(e1rmKg, unit) + step);
  return Math.round(fromDisplay(up, unit) * 100) / 100;
}
