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
  /** v_live_sets.id; dedupes the scan and lets a pending void find its set */
  id?: string;
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

/** One session's live sets of one exercise, as the scan saw them. */
export interface RecordSessionStat {
  id: string;
  /** live sets of this exercise in this session */
  n: number;
  /** newest performed_at among them */
  at: string;
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
  /** Per-session detail kept so `applyPendingToIndex` can subtract a pending
   *  void or discard and add unsent sets without a rescan. Absent on a bare
   *  entry (tests, goal-only rows), which is then left as it is. */
  sessions?: RecordSessionStat[];
  /** the newest few set ids, so a pending void can be matched to a session */
  setIds?: { id: string; session_id: string }[];
  /** v_session_best_e1rm rows, newest first, for the same reason */
  e1rms?: { session_id: string; at: string; kg: number }[];
  /** at least one set of this exercise is on this phone and not yet sent */
  onPhone?: boolean;
}

/** The index plus whether the scan ran out of pages (oldest exercises may be
 *  missing). */
export interface RecordIndex {
  entries: RecordIndexEntry[];
  truncated: boolean;
}

export interface RecordRow extends RecordIndexEntry {
  name: string;
  goal: GoalProgressRow | null;
}

/** How many newest set ids an entry remembers for matching pending voids. */
const KEEP_SET_IDS = 25;

function summarise(
  sessions: RecordSessionStat[],
  now: Date,
): { lastAt: string; recentSessions: number } {
  const cutoff = now.getTime() - RECENT_WINDOW_DAYS * 86_400_000;
  let lastAt = "";
  let recent = 0;
  for (const s of sessions) {
    if (s.at > lastAt) lastAt = s.at;
    if (new Date(s.at).getTime() >= cutoff) recent += 1;
  }
  return { lastAt, recentSessions: recent };
}

export function buildRecordIndex(
  sets: RecordSetRow[],
  e1rms: RecordE1rmRow[],
  now: Date = new Date(),
): RecordIndexEntry[] {
  const by = new Map<
    string,
    {
      sessions: Map<string, RecordSessionStat>;
      ids: { id: string; at: string; session_id: string }[];
      e1: RecordE1rmRow[];
    }
  >();
  for (const s of sets) {
    const cur = by.get(s.exercise_id) ?? {
      sessions: new Map<string, RecordSessionStat>(),
      ids: [],
      e1: [],
    };
    const ss = cur.sessions.get(s.session_id) ?? {
      id: s.session_id,
      n: 0,
      at: s.performed_at,
    };
    ss.n += 1;
    if (s.performed_at > ss.at) ss.at = s.performed_at;
    cur.sessions.set(s.session_id, ss);
    if (s.id) cur.ids.push({ id: s.id, at: s.performed_at, session_id: s.session_id });
    by.set(s.exercise_id, cur);
  }
  for (const r of e1rms) by.get(r.exercise_id)?.e1.push(r);
  return [...by.entries()].map(([exerciseId, v]) => {
    const sessions = [...v.sessions.values()];
    const e1 = v.e1.slice().sort((a, b) => (a.performed_at < b.performed_at ? 1 : -1));
    return {
      exerciseId,
      ...summarise(sessions, now),
      e1rmKg: e1[0]?.best_e1rm_kg ?? null,
      sessions,
      setIds: v.ids
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, KEEP_SET_IDS)
        .map(({ id, session_id }) => ({ id, session_id })),
      e1rms: e1.map((r) => ({
        session_id: r.session_id,
        at: r.performed_at,
        kg: r.best_e1rm_kg,
      })),
    };
  });
}

/** An unsent set insert, as far as the list cares. */
export interface PendingSetRef {
  id: string;
  exercise_id: string;
  session_id: string;
  performed_at: string;
}

/**
 * Lay what is still in this phone's outbox over the server's index: a set
 * voided or a session discarded here leaves the list before the server knows,
 * and an unsent set moves its exercise up and marks it "on phone".
 *
 * Derived numbers are NOT recomputed. e1RM only ever comes from the views, so
 * an unsent set adds a date and a session but never an e1RM; a discarded
 * session's e1RM is dropped and the next older one (also from the view) shows.
 * A pending void leaves the e1RM as the view had it (accepted gap).
 */
export function applyPendingToIndex(
  index: RecordIndexEntry[],
  pending: {
    voidedIds: Set<string>;
    discardedSessions: Set<string>;
    sets: PendingSetRef[];
  },
  now: Date = new Date(),
): RecordIndexEntry[] {
  const { voidedIds, discardedSessions } = pending;
  const unsent = new Map<string, PendingSetRef[]>();
  for (const s of pending.sets) {
    if (voidedIds.has(s.id) || discardedSessions.has(s.session_id)) continue;
    const l = unsent.get(s.exercise_id) ?? [];
    l.push(s);
    unsent.set(s.exercise_id, l);
  }
  const out: RecordIndexEntry[] = [];
  const handled = new Set<string>();
  for (const e of index) {
    handled.add(e.exerciseId);
    const mine = unsent.get(e.exerciseId) ?? [];
    if (!e.sessions) {
      if (mine.length === 0) out.push(e);
      else {
        const newest = mine.reduce((m, p) => (p.performed_at > m ? p.performed_at : m), e.lastAt);
        out.push({ ...e, lastAt: newest, onPhone: true });
      }
      continue;
    }
    const gone = new Map<string, number>();
    for (const v of e.setIds ?? []) {
      if (voidedIds.has(v.id))
        gone.set(v.session_id, (gone.get(v.session_id) ?? 0) + 1);
    }
    const sessions: RecordSessionStat[] = [];
    for (const s of e.sessions) {
      if (discardedSessions.has(s.id)) continue;
      const n = s.n - (gone.get(s.id) ?? 0);
      if (n > 0) sessions.push({ ...s, n });
    }
    for (const p of mine) {
      const ex = sessions.find((s) => s.id === p.session_id);
      if (ex) {
        ex.n += 1;
        if (p.performed_at > ex.at) ex.at = p.performed_at;
      } else {
        sessions.push({ id: p.session_id, n: 1, at: p.performed_at });
      }
    }
    if (sessions.length === 0) continue;
    const e1 = (e.e1rms ?? []).find((r) => !discardedSessions.has(r.session_id));
    out.push({
      ...e,
      ...summarise(sessions, now),
      e1rmKg: e.e1rms ? (e1?.kg ?? null) : e.e1rmKg,
      sessions,
      onPhone: mine.length > 0,
    });
  }
  for (const [exerciseId, mine] of unsent) {
    if (handled.has(exerciseId)) continue;
    const sessions: RecordSessionStat[] = [];
    for (const p of mine) {
      const ex = sessions.find((s) => s.id === p.session_id);
      if (ex) {
        ex.n += 1;
        if (p.performed_at > ex.at) ex.at = p.performed_at;
      } else sessions.push({ id: p.session_id, n: 1, at: p.performed_at });
    }
    out.push({
      exerciseId,
      ...summarise(sessions, now),
      e1rmKg: null,
      sessions,
      onPhone: true,
    });
  }
  return out;
}

/** The new percentage after a -/+ tap, shown until the view answers: the same
 *  ratio v_goal_progress computes (recent best / target, one decimal) from the
 *  view's own recent best. Display only, never stored or sent. */
export function optimisticPct(
  recentBestKg: number | null,
  targetKg: number,
): number | null {
  if (recentBestKg === null || targetKg <= 0) return null;
  return Math.round((recentBestKg / targetKg) * 1000) / 10;
}

/** Lowercase, accent- and punctuation-insensitive form for matching names. */
export function searchKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
  return a.name.localeCompare(b.name) || a.exerciseId.localeCompare(b.exerciseId);
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
  // every word of the query must appear, in any order ("press bench")
  const tokens = searchKey(search).split(" ").filter(Boolean);
  const shown =
    tokens.length === 0
      ? rows
      : rows.filter((r) => {
          const k = searchKey(r.name);
          return tokens.every((t) => k.includes(t));
        });
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
