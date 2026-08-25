import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must, requireExercise } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function defaultSince(): string {
  return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

export function registerGetLiftHistory(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_lift_history",
    {
      title: "Get lift history",
      description:
        "Full training history for one exercise: raw logged sets (newest first, " +
        "cap 500), best-e1RM-per-session series (Epley, working sets, 1-8 reps), " +
        "prescribed-vs-achieved adherence rows, and the current training max if " +
        "one exists. All loads are kg, dates ISO 8601.",
      inputSchema: {
        exercise_id: z
          .string()
          .min(1)
          .describe(
            "Exercise id slug (e.g. 'Barbell_Squat'). Use search_exercises to find it.",
          ),
        since: z
          .string()
          .regex(ISO_DATE, "must be an ISO date (YYYY-MM-DD)")
          .optional()
          .describe(
            "Only include data on or after this ISO date. Default: 90 days ago.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_lift_history", async () => {
        const exercise = await requireExercise(db, args.exercise_id);
        const since = args.since ?? defaultSince();
        const sinceTs = `${since}T00:00:00Z`;

        const [setsRes, e1rmRes, adherenceRes, tmRes] = await Promise.all([
          db.client
            .from("sets")
            .select(
              "id, session_id, prescription_id, set_index, set_type, load_kg, reps, performed_at",
            )
            .eq("user_id", db.ownerId)
            .eq("exercise_id", args.exercise_id)
            .gte("performed_at", sinceTs)
            .order("performed_at", { ascending: false })
            .limit(500),
          db.client
            .from("v_session_best_e1rm")
            .select("session_id, performed_at, best_e1rm_kg")
            .eq("user_id", db.ownerId)
            .eq("exercise_id", args.exercise_id)
            .gte("performed_at", sinceTs)
            .order("performed_at", { ascending: true }),
          db.client
            .from("v_adherence")
            .select(
              "set_id, session_id, prescription_id, set_index, performed_at, " +
                "actual_load_kg, actual_reps, reps_min, reps_max, prescribed_load_kg, " +
                "load_delta_kg, rep_outcome",
            )
            .eq("user_id", db.ownerId)
            .eq("exercise_id", args.exercise_id)
            .gte("performed_at", sinceTs)
            .order("performed_at", { ascending: true }),
          db.client
            .from("v_current_tm")
            .select("value_kg, effective_date")
            .eq("user_id", db.ownerId)
            .eq("exercise_id", args.exercise_id)
            .maybeSingle(),
        ]);

        if (tmRes.error) throw new Error(`current TM: ${tmRes.error.message}`);

        return jsonResult({
          exercise_id: exercise.id,
          exercise_name: exercise.name,
          since,
          current_training_max: tmRes.data, // null when no TM is set
          sets: must(setsRes, "sets"),
          e1rm_series: must(e1rmRes, "e1RM series"),
          adherence: must(adherenceRes, "adherence"),
        });
      }),
  );
}
