// Data export: the whole training record as JSON or CSV.
//
// The premise of this app is that you own your log, so it has to be able to
// hand it back. Read-only — nothing here writes to Postgres, and `sets`
// stays append-only.
//
// Reads go through the same views the app reads: `v_live_sets` (voids and
// discarded sessions already excluded) and `sessions` filtered to the ones
// that are not discarded. PostgREST caps a response at 1000 rows, so every
// query pages until it runs dry — an export that silently stopped at a
// thousand sets would be worse than none.

import { supabase } from "./supabase";
import { getExercises } from "./data";
import { exportSettings } from "./settings";

const PAGE = 1000;

export interface ExportSession {
  id: string;
  planned_workout_id: string | null;
  started_at: string;
  ended_at: string | null;
  session_rpe: number | null;
  bodyweight_kg: number | null;
  notes: string | null;
}

export interface ExportSet {
  id: string;
  session_id: string;
  exercise_id: string;
  prescription_id: string | null;
  set_index: number;
  set_type: string;
  load_kg: number;
  reps: number;
  performed_at: string;
  rest_seconds_actual: number | null;
  /** How the load was TYPED: 'total', 'per_side', or null for UNKNOWN.
   *  load_kg is always the total, so without this a pair of 30 kg dumbbells
   *  and a 60 kg barbell are indistinguishable in the user's own archive. */
  load_entry: string | null;
}

export interface ExportBundle {
  exported_at: string;
  app_version: string;
  /** the settings envelope, so a restore knows what units these were logged in */
  settings: { v: number; values: Record<string, unknown> };
  exercises: Record<string, string>;
  sessions: ExportSession[];
  sets: ExportSet[];
  set_notes: Record<string, string>;
}

const SESSION_COLUMNS =
  "id,planned_workout_id,started_at,ended_at,session_rpe,bodyweight_kg,notes";
// load_entry is NOT optional here. load_kg is always the total system load,
// and load_entry is the only record of how the lifter actually typed it — the
// difference between "a pair of 30s" and "60 on a bar". This is the canonical
// archive; dropping it makes that unrecoverable, and `sets` is append-only so
// it can never be reconstructed.
const SET_COLUMNS =
  "id,session_id,exercise_id,prescription_id,set_index,set_type,load_kg,reps,performed_at,rest_seconds_actual,load_entry";

/** Page through a PostgREST relation until it stops returning full pages.
 *
 *  Every caller MUST pass a total order. `range()` is LIMIT/OFFSET, and
 *  without an ORDER BY Postgres makes no promise that two queries walk the
 *  rows in the same sequence — so past one page, rows can repeat and rows can
 *  vanish. In an export that is meant to be the user's own complete archive,
 *  vanishing is the bad one, and it is silent. */
async function fetchAll<T>(
  build: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function buildExport(appVersion: string): Promise<ExportBundle> {
  const sessions = await fetchAll<ExportSession>((from, to) =>
    supabase
      .from("sessions")
      .select(SESSION_COLUMNS)
      .is("discarded_at", null)
      // started_at alone is not unique, and a tie can shuffle between pages
      .order("started_at")
      .order("id")
      .range(from, to),
  );

  const sets = await fetchAll<ExportSet>((from, to) =>
    supabase
      .from("v_live_sets")
      .select(SET_COLUMNS)
      // two sets can share a timestamp; id breaks the tie so the walk is stable
      .order("performed_at")
      .order("id")
      .range(from, to),
  );

  const notes = await fetchAll<{ set_id: string; note: string }>((from, to) =>
    supabase
      .from("set_notes")
      .select("set_id,note")
      // set_id is the primary key here, so this is a total order
      .order("set_id")
      .range(from, to),
  );

  const { data: exercises } = await getExercises();
  const names: Record<string, string> = {};
  for (const e of exercises) names[e.id] = e.name;

  return {
    exported_at: new Date().toISOString(),
    app_version: appVersion,
    settings: exportSettings(),
    exercises: names,
    sessions,
    sets,
    set_notes: Object.fromEntries(notes.map((n) => [n.set_id, n.note])),
  };
}

const CSV_HEADER = [
  "session_id",
  "session_started_at",
  "session_ended_at",
  "session_rpe",
  "bodyweight_kg",
  "session_notes",
  "set_id",
  "exercise_id",
  "exercise_name",
  "set_index",
  "set_type",
  "load_kg",
  "reps",
  "performed_at",
  "rest_seconds_actual",
  "set_note",
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // A leading =, +, - or @ is a formula in Excel/Sheets. Training notes are
  // free text, so prefix them out of formula position rather than trusting
  // whatever the user typed.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One row per set, session columns denormalised onto it. */
export function toCsv(bundle: ExportBundle): string {
  const byId = new Map(bundle.sessions.map((s) => [s.id, s]));
  const lines = [CSV_HEADER.join(",")];
  for (const set of bundle.sets) {
    const s = byId.get(set.session_id);
    lines.push(
      [
        set.session_id,
        s?.started_at ?? null,
        s?.ended_at ?? null,
        s?.session_rpe ?? null,
        s?.bodyweight_kg ?? null,
        s?.notes ?? null,
        set.id,
        set.exercise_id,
        bundle.exercises[set.exercise_id] ?? null,
        set.set_index,
        set.set_type,
        set.load_kg,
        set.reps,
        set.performed_at,
        set.rest_seconds_actual,
        bundle.set_notes[set.id] ?? null,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}

/** Hand the file to the browser. Blob URL, revoked on the next tick. */
export function downloadText(
  filename: string,
  mime: string,
  text: string,
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportFilename(ext: "json" | "csv"): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `strength-log-${stamp}.${ext}`;
}
