import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  session_rpe: number | null;
  bodyweight_kg: number | null;
  notes: string | null;
  planned_workouts: { label: string | null } | null;
}

export function registerGetRecentSessions(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_recent_sessions",
    {
      title: "Get recent sessions",
      description:
        "Most recent training sessions, newest first, with session RPE (0-10), " +
        "bodyweight (kg), notes, the planned workout label when the session " +
        "followed a program, and set counts (total and working). Pass " +
        "include_sets to get the sets themselves — exercise, warmup vs " +
        "working, load, reps and the lifter's per-set note — which is what " +
        "reviewing a workout actually needs. Loads are kg and are always the " +
        "TOTAL moved in one rep; load_entry says whether the lifter typed a " +
        "per-side number, so quote it back the way it was entered.",
      inputSchema: {
        include_sets: z
          .boolean()
          .default(false)
          .describe(
            "Return every logged set inside each session (exercise, order, " +
              "warmup/working, load, reps, and the lifter's note on that set). " +
              "This is what answers 'how did yesterday go' — without it you " +
              "get counts and have to guess which exercises were trained. " +
              "Keep n small when using it; capped at 400 sets across the " +
              "whole result.",
          ),
        n: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("Number of sessions to return. Default 10, max 50."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_recent_sessions", async () => {
        const sessions = must(
          await db.client
            .from("sessions")
            .select(
              "id, started_at, ended_at, session_rpe, bodyweight_kg, notes, planned_workouts(label)",
            )
            .eq("user_id", db.ownerId)
            .is("discarded_at", null)
            .order("started_at", { ascending: false })
            .limit(args.n),
          "sessions",
        ) as unknown as SessionRow[];

        // Counts come from v_session_set_counts: the DB aggregates, so results
        // stay correct past PostgREST's row cap (raw set rows would truncate
        // silently at 1000).
        const counts = new Map<string, { total: number; working: number }>();
        if (sessions.length > 0) {
          const countRows = must(
            await db.client
              .from("v_session_set_counts")
              .select("session_id, total_sets, working_sets")
              .eq("user_id", db.ownerId)
              .in(
                "session_id",
                sessions.map((s) => s.id),
              ),
            "set counts",
          ) as {
            session_id: string;
            total_sets: number;
            working_sets: number;
          }[];
          for (const row of countRows) {
            counts.set(row.session_id, {
              total: row.total_sets,
              working: row.working_sets,
            });
          }
        }

        // The actual work, when asked for. v_live_sets (not `sets`) so voided
        // sets and discarded sessions stay out, same as every other read.
        const setsBySession = new Map<string, unknown[]>();
        let setsTruncated = false;
        if (args.include_sets && sessions.length > 0) {
          const SET_CAP = 400;
          const setRows = must(
            await db.client
              .from("v_live_sets")
              .select(
                "id, session_id, exercise_id, set_index, set_type, load_kg, " +
                  "load_entry, reps, performed_at",
              )
              .eq("user_id", db.ownerId)
              .in(
                "session_id",
                sessions.map((s) => s.id),
              )
              .order("performed_at", { ascending: true })
              .limit(SET_CAP),
            "session sets",
          ) as unknown as {
            id: string;
            session_id: string;
            exercise_id: string;
          }[];
          setsTruncated = setRows.length === SET_CAP;

          // Names, so a reader is not handed exercise slugs, and notes, which
          // are the only place the lifter says how it felt.
          const exIds = [...new Set(setRows.map((r) => r.exercise_id))];
          const [nameRows, noteRows] = await Promise.all([
            exIds.length === 0
              ? Promise.resolve([])
              : (must(
                  await db.client
                    .from("exercises")
                    .select("id, name")
                    .in("id", exIds),
                  "exercise names",
                ) as unknown as { id: string; name: string }[]),
            setRows.length === 0
              ? Promise.resolve([])
              : (must(
                  await db.client
                    .from("set_notes")
                    .select("set_id, note")
                    .eq("user_id", db.ownerId)
                    .in(
                      "set_id",
                      setRows.map((r) => r.id),
                    ),
                  "set notes",
                ) as unknown as { set_id: string; note: string }[]),
          ]);
          const nameById = new Map(nameRows.map((e) => [e.id, e.name] as const));
          const noteById = new Map(
            noteRows.map((n) => [n.set_id, n.note] as const),
          );
          for (const r of setRows) {
            const note = noteById.get(r.id);
            const row = {
              ...r,
              exercise_name: nameById.get(r.exercise_id) ?? null,
              ...(note === undefined ? {} : { note }),
            };
            const list = setsBySession.get(r.session_id);
            if (list === undefined) setsBySession.set(r.session_id, [row]);
            else list.push(row);
          }
        }

        return jsonResult({
          count: sessions.length,
          ...(args.include_sets ? { sets_truncated: setsTruncated } : {}),
          sessions: sessions.map((s) => ({
            id: s.id,
            started_at: s.started_at,
            ended_at: s.ended_at,
            session_rpe: s.session_rpe,
            bodyweight_kg: s.bodyweight_kg,
            notes: s.notes,
            planned_workout_label: s.planned_workouts?.label ?? null,
            total_sets: counts.get(s.id)?.total ?? 0,
            working_sets: counts.get(s.id)?.working ?? 0,
            ...(args.include_sets
              ? { sets: setsBySession.get(s.id) ?? [] }
              : {}),
          })),
        });
      }),
  );
}
