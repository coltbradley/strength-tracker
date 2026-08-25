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
        "followed a program, and set counts (total and working).",
      inputSchema: {
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

        return jsonResult({
          count: sessions.length,
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
          })),
        });
      }),
  );
}
