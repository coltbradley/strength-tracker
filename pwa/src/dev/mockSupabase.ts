// DEV-ONLY demo harness. Not product code, never in the production bundle:
// `src/lib/supabase.ts` reaches this module through a dynamic import that is
// dead-code-eliminated unless VITE_DEMO=1 (see `npm run demo`).
//
// An in-memory stand-in for the PostgREST surface the app actually uses:
// a thenable builder over plain JS arrays, with the SQL views from
// supabase/migrations/*.sql reimplemented as derived queries. Writes mutate
// the store, so starting a session, logging sets, voiding, finishing and
// plan edits all behave for real without Supabase or Docker.
//
// This module MUST stay free of top-level side effects — Rollup drops it
// from the production build only because nothing here runs at import time.

import { cacheSet, cacheKeys, getDb } from "../lib/db";
import {
  buildScenario,
  DEMO_USER_ID,
  type DemoScenario,
  type DemoStore,
  type Row,
} from "./fixtures";
import { mountScenarioBadge } from "./scenarioBadge";

// ---- scenario selection ----------------------------------------------------

const SCENARIOS: DemoScenario[] = [
  "default",
  "empty",
  "orphan",
  "active",
  "undated",
  "offline",
];

/** `?demo=active` picks the scenario; it is remembered for the session so a
 *  reload (or a router navigation, which drops the query string) keeps it. */
function readScenario(): DemoScenario {
  let picked: DemoScenario | null = null;
  try {
    const param = new URLSearchParams(window.location.search).get("demo");
    if (param && (SCENARIOS as string[]).includes(param)) {
      picked = param as DemoScenario;
      window.sessionStorage.setItem("demoScenario", picked);
    } else {
      const saved = window.sessionStorage.getItem("demoScenario");
      if (saved && (SCENARIOS as string[]).includes(saved))
        picked = saved as DemoScenario;
    }
  } catch {
    // private mode / no storage: fall through to the default
  }
  return picked ?? "default";
}

/** Every scenario starts from a known device state, so switching scenarios
 *  can't leave a stale activeSession pointer or half-flushed outbox behind.
 *  `offline` is the exception: it exists to render what the cache kept.
 *
 *  Clearing the stores, NOT deleting the database: `deleteDatabase` blocks
 *  whenever another tab holds a connection, and a blocked delete parks every
 *  later `open` behind it — the app then hangs on its first cache read with
 *  no error to show for it. */
async function wipeLocalData(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear("kv");
    await db.clear("outbox");
  } catch {
    // no storage (private mode): the demo still runs, just without a cache
  }
}

// ---- result shapes ---------------------------------------------------------

interface PostgrestError {
  message: string;
  code: string;
  details: string;
  hint: string;
}

interface Result {
  data: unknown;
  error: PostgrestError | null;
  status: number;
  statusText: string;
  count: number | null;
}

const OFFLINE_ERROR: PostgrestError = {
  message: "TypeError: Failed to fetch",
  code: "",
  details: "",
  hint: "",
};

// ---- view derivation (mirrors supabase/migrations/*.sql) --------------------

function localDateIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO Monday of the local week containing `ts` — date_trunc('week', ...). */
function weekStartIso(ts: string): string {
  const d = new Date(ts);
  const dow = d.getDay(); // 0=Sun
  const offset = dow === 0 ? -6 : 1 - dow;
  return localDateIso(
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset),
  );
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

/** v_live_sets: sets minus voids minus discarded sessions. */
function vLiveSets(s: DemoStore): Row[] {
  const discarded = new Set(
    s.sessions.filter((x) => x.discarded_at !== null).map((x) => x.id),
  );
  const voided = new Set(s.set_voids.map((v) => v.set_id));
  return s.sets.filter(
    (x) => !discarded.has(x.session_id as string) && !voided.has(x.id),
  );
}

/** v_current_tm: latest effective_date <= today, per user/exercise. */
function vCurrentTm(s: DemoStore): Row[] {
  const today = localDateIso(new Date());
  const best = new Map<string, Row>();
  for (const tm of s.training_maxes) {
    if ((tm.effective_date as string) > today) continue;
    const key = `${tm.user_id as string}|${tm.exercise_id as string}`;
    const cur = best.get(key);
    if (!cur || (tm.effective_date as string) > (cur.effective_date as string))
      best.set(key, tm);
  }
  return [...best.values()];
}

function vResolvedPrescriptions(s: DemoStore): Row[] {
  const tms = vCurrentTm(s);
  const byExercise = new Map(s.exercises.map((e) => [e.id as string, e]));
  return s.prescriptions.flatMap((p) => {
    const ex = byExercise.get(p.exercise_id as string);
    if (!ex) return []; // inner join on exercises
    const tm =
      tms.find(
        (t) => t.user_id === p.user_id && t.exercise_id === p.exercise_id,
      ) ?? null;
    const tmKg = tm ? num(tm.value_kg) : null;
    const pct = p.load_pct_tm === null ? null : num(p.load_pct_tm);
    const resolved =
      p.load_kg !== null
        ? num(p.load_kg)
        : pct !== null && tmKg !== null
          ? round((pct / 100) * tmKg, 1)
          : null;
    return [
      {
        id: p.id,
        user_id: p.user_id,
        planned_workout_id: p.planned_workout_id,
        exercise_id: p.exercise_id,
        exercise_name: ex.name,
        position: p.position,
        sets: p.sets,
        reps_min: p.reps_min,
        reps_max: p.reps_max,
        rest_seconds: p.rest_seconds,
        notes: p.notes,
        load_kg: p.load_kg,
        load_pct_tm: p.load_pct_tm,
        tm_kg: tmKg,
        resolved_load_kg: resolved,
        plate_load_kg:
          resolved === null ? null : Math.round(resolved / 2.5) * 2.5,
        superset_group: p.superset_group,
        load_entry: p.load_entry ?? null,
        // Column default is 'working' (20260830120000_prescription_set_type),
        // so an unset fixture must read as working, never as undefined.
        set_type: p.set_type ?? "working",
      },
    ];
  });
}

/**
 * v_adherence (20260827160000_per_side_load.sql): every live working/backoff
 * set that fulfilled a prescription, beside what that prescription asked for.
 * Faithful to the SQL, including the two details that matter:
 *
 * - prescribed_load_kg resolves %TM against the TM effective ON THE DAY THE
 *   SET WAS PERFORMED (the lateral join), not today's TM.
 * - both entry modes are carried through unchanged, so a null stays a null
 *   and a reader can tell "total" from "not asserted".
 */
function vAdherence(s: DemoStore): Row[] {
  const byId = new Map(s.prescriptions.map((p) => [p.id as string, p]));
  return vLiveSets(s).flatMap((x) => {
    if (x.set_type !== "working" && x.set_type !== "backoff") return [];
    const p = byId.get(x.prescription_id as string);
    if (!p) return []; // inner join on prescriptions
    const day = localDateIso(new Date(x.performed_at as string));
    const tm = s.training_maxes
      .filter(
        (t) =>
          t.user_id === x.user_id &&
          t.exercise_id === x.exercise_id &&
          (t.effective_date as string) <= day,
      )
      .sort((a, b) =>
        (a.effective_date as string) < (b.effective_date as string) ? 1 : -1,
      )[0];
    const pct = p.load_pct_tm === null ? null : num(p.load_pct_tm);
    const prescribed =
      p.load_kg !== null
        ? num(p.load_kg)
        : pct !== null && tm
          ? round((pct / 100) * num(tm.value_kg), 1)
          : null;
    const reps = num(x.reps);
    return [
      {
        set_id: x.id,
        user_id: x.user_id,
        session_id: x.session_id,
        exercise_id: x.exercise_id,
        prescription_id: x.prescription_id,
        set_index: x.set_index,
        performed_at: x.performed_at,
        actual_load_kg: x.load_kg,
        actual_reps: x.reps,
        reps_min: p.reps_min,
        reps_max: p.reps_max,
        prescribed_load_kg: prescribed,
        load_delta_kg:
          prescribed === null ? null : round(num(x.load_kg) - prescribed, 2),
        rep_outcome:
          reps < num(p.reps_min)
            ? "missed"
            : reps > num(p.reps_max)
              ? "exceeded"
              : "hit",
        actual_load_entry: x.load_entry ?? null,
        prescribed_load_entry: p.load_entry ?? null,
      },
    ];
  });
}

/** v_e1rm: Epley over working sets, 1-8 reps, load > 0. */
function vE1rm(s: DemoStore): Row[] {
  return vLiveSets(s)
    .filter(
      (x) =>
        x.set_type === "working" &&
        num(x.reps) >= 1 &&
        num(x.reps) <= 8 &&
        num(x.load_kg) > 0,
    )
    .map((x) => ({
      user_id: x.user_id,
      exercise_id: x.exercise_id,
      session_id: x.session_id,
      set_id: x.id,
      performed_at: x.performed_at,
      load_kg: x.load_kg,
      reps: x.reps,
      e1rm_kg: round(num(x.load_kg) * (1 + num(x.reps) / 30), 1),
    }));
}

function vSessionBestE1rm(s: DemoStore): Row[] {
  const groups = new Map<string, Row[]>();
  for (const r of vE1rm(s)) {
    const key = `${r.user_id as string}|${r.exercise_id as string}|${r.session_id as string}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  return [...groups.values()].map((rows) => ({
    user_id: rows[0].user_id,
    exercise_id: rows[0].exercise_id,
    session_id: rows[0].session_id,
    performed_at: rows
      .map((r) => r.performed_at as string)
      .reduce((a, b) => (a < b ? a : b)),
    best_e1rm_kg: Math.max(...rows.map((r) => num(r.e1rm_kg))),
  }));
}

function vWeeklyVolume(s: DemoStore): Row[] {
  const groups = new Map<string, Row[]>();
  for (const x of vLiveSets(s)) {
    if (x.set_type !== "working") continue;
    const key = `${x.user_id as string}|${x.exercise_id as string}|${weekStartIso(x.performed_at as string)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(x);
  }
  return [...groups.entries()].map(([key, rows]) => ({
    user_id: rows[0].user_id,
    exercise_id: rows[0].exercise_id,
    week_start: key.split("|")[2],
    working_sets: rows.length,
    tonnage_kg: round(
      rows.reduce((n, r) => n + num(r.load_kg) * num(r.reps), 0),
      2,
    ),
  }));
}

function vSessionSetCounts(s: DemoStore): Row[] {
  const groups = new Map<string, Row[]>();
  for (const x of vLiveSets(s)) {
    const key = `${x.user_id as string}|${x.session_id as string}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(x);
  }
  return [...groups.values()].map((rows) => ({
    user_id: rows[0].user_id,
    session_id: rows[0].session_id,
    total_sets: rows.length,
    working_sets: rows.filter((r) => r.set_type === "working").length,
  }));
}

function vGoalProgress(s: DemoStore): Row[] {
  const e1rm = vE1rm(s);
  const cutoff = new Date(Date.now() - 45 * 86400_000).toISOString();
  const byExercise = new Map(s.exercises.map((e) => [e.id as string, e]));
  return s.goals.flatMap((g) => {
    const ex = byExercise.get(g.exercise_id as string);
    if (!ex) return [];
    const mine = e1rm.filter(
      (v) => v.user_id === g.user_id && v.exercise_id === g.exercise_id,
    );
    const recent = mine.filter((v) => (v.performed_at as string) > cutoff);
    const best = (rows: Row[]): number | null =>
      rows.length === 0 ? null : Math.max(...rows.map((r) => num(r.e1rm_kg)));
    const recentBest = best(recent);
    const target = num(g.target_e1rm_kg);
    return [
      {
        goal_id: g.id,
        user_id: g.user_id,
        exercise_id: g.exercise_id,
        exercise_name: ex.name,
        target_e1rm_kg: target,
        target_date: g.target_date,
        recent_best_e1rm_kg: recentBest,
        alltime_best_e1rm_kg: best(mine),
        pct_of_target:
          recentBest === null ? null : round((recentBest / target) * 100, 1),
      },
    ];
  });
}

/**
 * v_plan_workouts (20260831020000_workout_templates.sql): the plannable days.
 * A saved template is a dateless planned_workout, and this is what keeps it
 * off the calendar and out of the DAY 1..N fallback.
 */
function vPlanWorkouts(s: DemoStore): Row[] {
  return (s.planned_workouts ?? []).filter((w) => w.is_template !== true);
}

const VIEWS: Record<string, (s: DemoStore) => Row[]> = {
  v_plan_workouts: vPlanWorkouts,
  v_live_sets: vLiveSets,
  v_current_tm: vCurrentTm,
  v_resolved_prescriptions: vResolvedPrescriptions,
  v_e1rm: vE1rm,
  v_session_best_e1rm: vSessionBestE1rm,
  v_weekly_volume: vWeeklyVolume,
  v_session_set_counts: vSessionSetCounts,
  v_goal_progress: vGoalProgress,
  v_adherence: vAdherence,
};

// ---- filtering / ordering / projection --------------------------------------

interface Filter {
  col: string;
  op: string;
  val: unknown;
  negate: boolean;
}

/** Range comparison the way Postgres does it: numerically for numbers,
 *  lexicographically for text and timestamptz. Coercing everything through
 *  Number() made every keyset cursor (`lt(performed_at, ...)`,
 *  `gt(exercise_id, ...)`) compare NaN and silently return nothing. */
function ordered(a: unknown, b: unknown): number {
  const na = num(a);
  const nb = num(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== "" && b !== "")
    return na - nb;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col] ?? null;
  let hit: boolean;
  switch (f.op) {
    case "eq":
      hit = String(v) === String(f.val);
      break;
    case "neq":
      hit = String(v) !== String(f.val);
      break;
    case "is":
      hit = f.val === null ? v === null : v === f.val;
      break;
    case "in":
      hit = (f.val as unknown[]).some((x) => String(x) === String(v));
      break;
    case "gt":
      hit = v !== null && ordered(v, f.val) > 0;
      break;
    case "gte":
      hit = v !== null && ordered(v, f.val) >= 0;
      break;
    case "lt":
      hit = v !== null && ordered(v, f.val) < 0;
      break;
    case "lte":
      hit = v !== null && ordered(v, f.val) <= 0;
      break;
    case "like":
    case "ilike": {
      const pattern = String(f.val).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      hit = new RegExp(
        `^${pattern.replace(/%/g, ".*")}$`,
        f.op === "ilike" ? "i" : "",
      ).test(String(v));
      break;
    }
    default:
      throw new Error(`mockSupabase: unsupported filter op "${f.op}"`);
  }
  return f.negate ? !hit : hit;
}

function compare(a: unknown, b: unknown): number {
  if (a === null || a === undefined)
    return b === null || b === undefined ? 0 : 1; // nulls last
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function project(row: Row, columns: string): Row {
  const cols = columns.trim();
  if (cols === "" || cols === "*") return { ...row };
  const out: Row = {};
  for (const raw of cols.split(",")) {
    const col = raw.trim();
    if (col === "*") return { ...row };
    if (col !== "") out[col] = row[col] ?? null;
  }
  return out;
}

// ---- the builder ------------------------------------------------------------

type Op = "select" | "insert" | "upsert" | "update" | "delete";

interface BuilderState {
  table: string;
  op: Op;
  columns: string;
  filters: Filter[];
  orders: { col: string; ascending: boolean }[];
  limit: number | null;
  payload: unknown;
  patch: Row | null;
  onConflict: string;
  ignoreDuplicates: boolean;
  cardinality: "many" | "maybeSingle" | "single";
}

export interface MockQuery extends PromiseLike<Result> {
  select(columns?: string): MockQuery;
  insert(payload: unknown): MockQuery;
  upsert(
    payload: unknown,
    options?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): MockQuery;
  update(patch: Row): MockQuery;
  delete(): MockQuery;
  eq(col: string, val: unknown): MockQuery;
  neq(col: string, val: unknown): MockQuery;
  is(col: string, val: unknown): MockQuery;
  in(col: string, vals: unknown[]): MockQuery;
  gt(col: string, val: unknown): MockQuery;
  gte(col: string, val: unknown): MockQuery;
  lt(col: string, val: unknown): MockQuery;
  lte(col: string, val: unknown): MockQuery;
  not(col: string, op: string, val: unknown): MockQuery;
  filter(col: string, op: string, val: unknown): MockQuery;
  order(col: string, options?: { ascending?: boolean }): MockQuery;
  limit(n: number): MockQuery;
  maybeSingle(): MockQuery;
  single(): MockQuery;
}

function ok(data: unknown, status = 200): Result {
  return { data, error: null, status, statusText: "OK", count: null };
}

function fail(error: PostgrestError, status: number): Result {
  return { data: null, error, status, statusText: "Error", count: null };
}

interface Engine {
  store: DemoStore;
  offline: boolean;
  log: (...args: unknown[]) => void;
}

function rowsToArray(payload: unknown): Row[] {
  return (Array.isArray(payload) ? payload : [payload]) as Row[];
}

/** Server-side column defaults, so freshly inserted rows behave like real
 *  ones in the views (a session needs ended_at/discarded_at to be null, not
 *  absent, for `is('discarded_at', null)` and v_live_sets to work). */
const DEFAULTS: Record<string, Row> = {
  sessions: {
    planned_workout_id: null,
    ended_at: null,
    discarded_at: null,
    session_rpe: null,
    bodyweight_kg: null,
    notes: null,
  },
  sets: {
    prescription_id: null,
    set_type: "working",
    rest_seconds_actual: null,
    load_entry: null,
  },
  set_voids: {},
  set_notes: {},
  planned_workouts: {
    label: null,
    notes: null,
    scheduled_date: null,
    plan_note: null,
    skipped_at: null,
  },
  prescriptions: {
    load_kg: null,
    load_pct_tm: null,
    rest_seconds: null,
    notes: null,
    superset_group: null,
    load_entry: null,
  },
  programs: { source_note: null, confirmed_at: null },
};

function withDefaults(table: string, row: Row): Row {
  const now = new Date().toISOString();
  return {
    ...(DEFAULTS[table] ?? {}),
    user_id: DEMO_USER_ID,
    created_at: now,
    // `id uuid default gen_random_uuid()`: a client that lets the database
    // name the row (training_maxes does — its identity is the unique triple,
    // not the id) must still come back with one
    id: `mock-${Math.random().toString(36).slice(2, 12)}`,
    ...row,
  };
}

function createQuery(engine: Engine, table: string): MockQuery {
  const state: BuilderState = {
    table,
    op: "select",
    columns: "*",
    filters: [],
    orders: [],
    limit: null,
    payload: null,
    patch: null,
    onConflict: "id",
    ignoreDuplicates: false,
    cardinality: "many",
  };

  const base = (): Row[] => {
    const view = VIEWS[state.table];
    if (view) return view(engine.store);
    const rows = engine.store[state.table as keyof DemoStore];
    if (!rows)
      throw new Error(`mockSupabase: unknown relation "${state.table}"`);
    return rows;
  };

  /** Base-table rows (never a view) for writes. */
  const writable = (): Row[] => {
    const rows = engine.store[state.table as keyof DemoStore];
    if (!rows)
      throw new Error(`mockSupabase: cannot write to "${state.table}"`);
    return rows;
  };

  const run = (): Result => {
    if (engine.offline) return fail(OFFLINE_ERROR, 0);
    try {
      switch (state.op) {
        case "select": {
          let rows = base().filter((r) =>
            state.filters.every((f) => matches(r, f)),
          );
          for (const o of [...state.orders].reverse()) {
            rows = [...rows].sort((a, b) => {
              const c = compare(a[o.col] ?? null, b[o.col] ?? null);
              return o.ascending ? c : -c;
            });
          }
          if (state.limit !== null) rows = rows.slice(0, state.limit);
          const projected = rows.map((r) => project(r, state.columns));
          if (state.cardinality === "many") return ok(projected);
          if (projected.length > 1)
            return fail(
              {
                message: "JSON object requested, multiple rows returned",
                code: "PGRST116",
                details: "",
                hint: "",
              },
              406,
            );
          if (projected.length === 0 && state.cardinality === "single")
            return fail(
              {
                message: "JSON object requested, 0 rows returned",
                code: "PGRST116",
                details: "",
                hint: "",
              },
              406,
            );
          return ok(projected[0] ?? null);
        }
        case "insert":
        case "upsert": {
          const rows = writable();
          // PostgREST's on_conflict can name a composite unique constraint
          // (training_maxes is unique on user_id,exercise_id,effective_date),
          // so the conflict target is a column LIST, not a single key.
          const keys =
            state.op === "upsert"
              ? state.onConflict.split(",").map((k) => k.trim())
              : ["id"];
          for (const incoming of rowsToArray(state.payload)) {
            const row = withDefaults(state.table, incoming);
            const idx = rows.findIndex((r) =>
              keys.every(
                (k) => String(r[k] ?? null) === String(row[k] ?? null),
              ),
            );
            if (idx === -1) {
              rows.push(row);
              continue;
            }
            if (state.op === "insert")
              return fail(
                {
                  message: `duplicate key value violates unique constraint "${state.table}_pkey"`,
                  code: "23505",
                  details: "",
                  hint: "",
                },
                409,
              );
            if (state.ignoreDuplicates) continue; // on conflict do nothing
            rows[idx] = { ...rows[idx], ...incoming };
          }
          return ok(null, 201);
        }
        case "update": {
          const rows = writable();
          for (let i = 0; i < rows.length; i++) {
            if (state.filters.every((f) => matches(rows[i], f)))
              rows[i] = { ...rows[i], ...(state.patch ?? {}) };
          }
          return ok(null, 204);
        }
        case "delete": {
          const rows = writable();
          const doomed = rows.filter((r) =>
            state.filters.every((f) => matches(r, f)),
          );
          const ids = new Set(doomed.map((r) => r.id));
          engine.store[state.table as keyof DemoStore] = rows.filter(
            (r) => !ids.has(r.id),
          );
          cascadeDelete(engine.store, state.table, ids);
          return ok(null, 204);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      engine.log("mockSupabase error:", message);
      return fail({ message, code: "MOCK", details: "", hint: "" }, 500);
    }
  };

  const q: MockQuery = {
    select(columns = "*") {
      if (state.op === "select") state.columns = columns;
      return q;
    },
    insert(payload) {
      state.op = "insert";
      state.payload = payload;
      return q;
    },
    upsert(payload, options) {
      state.op = "upsert";
      state.payload = payload;
      state.onConflict = options?.onConflict ?? "id";
      state.ignoreDuplicates = options?.ignoreDuplicates ?? false;
      return q;
    },
    update(patch) {
      state.op = "update";
      state.patch = patch;
      return q;
    },
    delete() {
      state.op = "delete";
      return q;
    },
    eq: (col, val) => push(col, "eq", val, false),
    neq: (col, val) => push(col, "neq", val, false),
    is: (col, val) => push(col, "is", val, false),
    in: (col, vals) => push(col, "in", vals, false),
    gt: (col, val) => push(col, "gt", val, false),
    gte: (col, val) => push(col, "gte", val, false),
    lt: (col, val) => push(col, "lt", val, false),
    lte: (col, val) => push(col, "lte", val, false),
    not: (col, op, val) => push(col, op, val, true),
    filter: (col, op, val) => push(col, op, val, false),
    order(col, options) {
      state.orders.push({ col, ascending: options?.ascending ?? true });
      return q;
    },
    limit(n) {
      state.limit = n;
      return q;
    },
    maybeSingle() {
      state.cardinality = "maybeSingle";
      return q;
    },
    single() {
      state.cardinality = "single";
      return q;
    },
    then(onfulfilled, onrejected) {
      // Every query resolves on a macrotask, like a real network round trip,
      // so nothing in the app accidentally depends on synchronous data.
      return new Promise<Result>((resolve) => {
        setTimeout(() => resolve(run()), engine.offline ? 120 : 8);
      }).then(onfulfilled, onrejected);
    },
  };

  function push(
    col: string,
    op: string,
    val: unknown,
    negate: boolean,
  ): MockQuery {
    state.filters.push({ col, op, val, negate });
    return q;
  }

  return q;
}

/** FK behaviour the schema declares: prescriptions cascade off a planned
 *  workout, sessions/sets keep their rows but lose the dangling link. */
function cascadeDelete(store: DemoStore, table: string, ids: Set<unknown>) {
  if (table === "planned_workouts") {
    const rxIds = new Set(
      store.prescriptions
        .filter((p) => ids.has(p.planned_workout_id))
        .map((p) => p.id),
    );
    store.prescriptions = store.prescriptions.filter(
      (p) => !ids.has(p.planned_workout_id),
    );
    for (const s of store.sessions)
      if (ids.has(s.planned_workout_id)) s.planned_workout_id = null;
    for (const s of store.sets)
      if (rxIds.has(s.prescription_id)) s.prescription_id = null;
  }
  if (table === "prescriptions") {
    for (const s of store.sets)
      if (ids.has(s.prescription_id)) s.prescription_id = null;
  }
}

// ---- auth -------------------------------------------------------------------

type AuthCallback = (event: string, session: unknown) => void;

function demoSession(): Row {
  const nowSec = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  return {
    access_token: "demo-access-token",
    refresh_token: "demo-refresh-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: nowSec + 3600,
    user: {
      id: DEMO_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: "demo@strength.log",
      email_confirmed_at: nowIso,
      phone: "",
      confirmed_at: nowIso,
      last_sign_in_at: nowIso,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      identities: [],
      created_at: nowIso,
      updated_at: nowIso,
      is_anonymous: false,
    },
  };
}

// ---- factory ----------------------------------------------------------------

export interface MockSupabase {
  from(table: string): MockQuery;
  auth: Record<string, unknown>;
  /** escape hatch for poking at the demo store from the console */
  __demo: { scenario: DemoScenario; store: DemoStore };
}

export async function createMockSupabase(): Promise<MockSupabase> {
  const scenario = readScenario();
  const log = (...args: unknown[]) => console.info("[demo]", ...args);

  // `offline` deliberately keeps whatever the previous run cached — that is
  // the only way the offline banners have anything to render.
  if (scenario !== "offline") await wipeLocalData();

  const { store, activeSessionCache } = buildScenario(scenario);
  const engine: Engine = { store, offline: scenario === "offline", log };

  if (activeSessionCache) {
    await cacheSet(cacheKeys.activeSession, activeSessionCache.session);
    await cacheSet(
      cacheKeys.sessionRx(activeSessionCache.session.id),
      activeSessionCache.prescriptions,
    );
  }

  let session: Row | null = demoSession();
  const listeners = new Set<AuthCallback>();
  const emit = (event: string) => {
    for (const fn of listeners) fn(event, session);
  };

  log(
    `scenario "${scenario}" — ${store.exercises.length} exercises, ` +
      `${store.planned_workouts.length} planned workouts, ` +
      `${store.sessions.length} sessions, ${store.sets.length} sets`,
  );

  const auth: Record<string, unknown> = {
    getSession: async () => ({ data: { session }, error: null }),
    getUser: async () => ({
      data: { user: session ? session.user : null },
      error: null,
    }),
    refreshSession: async () => ({ data: { session }, error: null }),
    onAuthStateChange: (cb: AuthCallback) => {
      listeners.add(cb);
      // supabase-js fires INITIAL_SESSION on subscribe. The mock did not, so
      // anything keyed off the first auth event (the device-cache ownership
      // check) never ran in the demo and the harness silently stopped covering
      // it. Async, matching the real client, so subscribe() returns first.
      queueMicrotask(() => {
        if (listeners.has(cb)) cb("INITIAL_SESSION", session);
      });
      return {
        data: {
          subscription: {
            id: "demo-sub",
            callback: cb,
            unsubscribe: () => listeners.delete(cb),
          },
        },
      };
    },
    // Signing in from the demo Login screen always succeeds immediately.
    signInWithOtp: async () => {
      session = demoSession();
      emit("SIGNED_IN");
      return { data: { user: session.user, session }, error: null };
    },
    verifyOtp: async () => {
      session = demoSession();
      emit("SIGNED_IN");
      return { data: { user: session.user, session }, error: null };
    },
    signOut: async () => {
      session = null;
      emit("SIGNED_OUT");
      return { error: null };
    },
  };

  const client: MockSupabase = {
    from: (table: string) => createQuery(engine, table),
    auth,
    __demo: { scenario, store },
  };
  (window as unknown as Record<string, unknown>).__demo = client.__demo;
  mountScenarioBadge(scenario);
  return client;
}
