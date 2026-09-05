// "Last time": what was actually logged the most recent time a planned day was
// trained. Shared by find_similar_days (which shows it) and
// repeat_planned_workout (which carries it forward), so the two describe the
// same session in the same words.
//
// Reads v_live_sets and v_adherence, never `sets`: voided sets and discarded
// sessions are already gone at the view, and a repeat built on a set the
// lifter corrected would carry the typo forward.

import type { Db } from "./db.ts";
import { must } from "./db.ts";
import {
  type LoggedSet,
  performedOrder,
  readsAsInstruction,
} from "./loop.ts";

export interface LastTimeSet extends LoggedSet {
  set_id: string;
  exercise_name: string | null;
  /** from v_adherence, for working/backoff sets that had a prescription */
  prescribed_load_kg?: number | null;
  rep_outcome?: "missed" | "hit" | "exceeded";
}

export interface NoteToConsider {
  exercise_id: string;
  exercise_name: string | null;
  set_index: number;
  note: string;
}

export interface LastTime {
  session: {
    id: string;
    started_at: string;
    ended_at: string | null;
    session_rpe: number | null;
    notes: string | null;
  };
  /** every live set of that session, in the order performed */
  sets: LastTimeSet[];
  /** exercise ids by FIRST performed_at */
  performed_order: string[];
  /** set notes that read as instructions to next time (see loop.ts) */
  notes_to_consider: NoteToConsider[];
  /** the remaining set notes, so nothing the lifter wrote is hidden */
  other_notes: NoteToConsider[];
}

interface SessionRow {
  id: string;
  planned_workout_id: string;
  started_at: string;
  ended_at: string | null;
  session_rpe: number | null;
  notes: string | null;
}

interface SetRow {
  id: string;
  session_id: string;
  exercise_id: string;
  set_index: number;
  set_type: string;
  load_kg: number;
  load_entry: string | null;
  reps: number;
  performed_at: string;
}

/** PostgREST answers at most 1000 rows; a handful of sessions is far below
 *  that, but the cap is reported rather than trusted. */
const SET_CAP = 1000;

/**
 * The most recent non-discarded session against each of `plannedWorkoutIds`,
 * with its sets, adherence and notes. Days never trained are absent from the
 * map. Every read is scoped to db.ownerId in code: this is the service role.
 */
export async function lastTimeFor(
  db: Db,
  plannedWorkoutIds: string[],
): Promise<{ byDay: Map<string, LastTime>; sets_truncated: boolean }> {
  const byDay = new Map<string, LastTime>();
  if (plannedWorkoutIds.length === 0) return { byDay, sets_truncated: false };

  const sessions = must(
    await db.client
      .from("sessions")
      .select("id, planned_workout_id, started_at, ended_at, session_rpe, notes")
      .eq("user_id", db.ownerId)
      .is("discarded_at", null)
      .in("planned_workout_id", plannedWorkoutIds)
      .order("started_at", { ascending: false }),
    "sessions against planned days",
  ) as SessionRow[];

  // newest first, so the first session seen per day is the last time
  const latest = new Map<string, SessionRow>();
  for (const s of sessions) {
    if (!latest.has(s.planned_workout_id)) latest.set(s.planned_workout_id, s);
  }
  if (latest.size === 0) return { byDay, sets_truncated: false };
  const sessionIds = [...latest.values()].map((s) => s.id);

  const setRows = must(
    await db.client
      .from("v_live_sets")
      .select(
        "id, session_id, exercise_id, set_index, set_type, load_kg, " +
          "load_entry, reps, performed_at",
      )
      .eq("user_id", db.ownerId)
      .in("session_id", sessionIds)
      .order("performed_at", { ascending: true })
      .limit(SET_CAP),
    "last time's sets",
  ) as unknown as SetRow[];
  const truncated = setRows.length === SET_CAP;

  const exIds = [...new Set(setRows.map((r) => r.exercise_id))];
  const setIds = setRows.map((r) => r.id);
  // Three small reads, in sequence: PostgREST calls from an edge function are
  // milliseconds apart and the code that reads them stays flat.
  const nameRows = exIds.length === 0 ? [] : must(
    await db.client.from("exercises").select("id, name").in("id", exIds),
    "exercise names",
  ) as { id: string; name: string }[];
  const noteRows = setIds.length === 0 ? [] : must(
    await db.client
      .from("set_notes")
      .select("set_id, note")
      .eq("user_id", db.ownerId)
      .in("set_id", setIds),
    "set notes",
  ) as { set_id: string; note: string }[];
  const adherenceRows = must(
    await db.client
      .from("v_adherence")
      .select("set_id, prescribed_load_kg, rep_outcome")
      .eq("user_id", db.ownerId)
      .in("session_id", sessionIds),
    "adherence",
  ) as {
    set_id: string;
    prescribed_load_kg: number | null;
    rep_outcome: "missed" | "hit" | "exceeded";
  }[];
  const nameById = new Map(nameRows.map((e) => [e.id, e.name] as const));
  const noteById = new Map(noteRows.map((n) => [n.set_id, n.note] as const));
  const adherenceById = new Map(
    adherenceRows.map((a) => [a.set_id, a] as const),
  );

  const setsBySession = new Map<string, LastTimeSet[]>();
  for (const r of setRows) {
    const note = noteById.get(r.id);
    const adh = adherenceById.get(r.id);
    const row: LastTimeSet = {
      set_id: r.id,
      exercise_id: r.exercise_id,
      exercise_name: nameById.get(r.exercise_id) ?? null,
      set_index: r.set_index,
      set_type: r.set_type,
      load_kg: r.load_kg,
      load_entry: r.load_entry,
      reps: r.reps,
      performed_at: r.performed_at,
      ...(note === undefined ? {} : { note }),
      ...(adh === undefined ? {} : {
        prescribed_load_kg: adh.prescribed_load_kg,
        rep_outcome: adh.rep_outcome,
      }),
    };
    const list = setsBySession.get(r.session_id);
    if (list === undefined) setsBySession.set(r.session_id, [row]);
    else list.push(row);
  }

  for (const [dayId, s] of latest) {
    const sets = setsBySession.get(s.id) ?? [];
    const noted = sets.filter((x): x is LastTimeSet & { note: string } =>
      x.note !== undefined && x.note.trim() !== ""
    );
    const toNote = (x: LastTimeSet & { note: string }): NoteToConsider => ({
      exercise_id: x.exercise_id,
      exercise_name: x.exercise_name,
      set_index: x.set_index,
      note: x.note,
    });
    byDay.set(dayId, {
      session: {
        id: s.id,
        started_at: s.started_at,
        ended_at: s.ended_at,
        session_rpe: s.session_rpe,
        notes: s.notes,
      },
      sets,
      performed_order: performedOrder(sets),
      notes_to_consider: noted.filter((x) => readsAsInstruction(x.note)).map(
        toNote,
      ),
      other_notes: noted.filter((x) => !readsAsInstruction(x.note)).map(toNote),
    });
  }
  return { byDay, sets_truncated: truncated };
}
