import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must, requireExercise } from "../lib/db.ts";
import { assertIsoDate } from "../lib/dates.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

export function registerSetGoal(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "set_goal",
    {
      title: "Set goal",
      description:
        "Set an e1RM goal for an exercise, in kg, with an optional target date. " +
        "One goal per exercise: setting a new one replaces any existing goal for " +
        "that exercise. Track progress with get_goal_progress.",
      inputSchema: {
        exercise_id: z
          .string()
          .min(1)
          .describe(
            "Exercise id slug (e.g. 'Barbell_Deadlift'). Use search_exercises to find it.",
          ),
        target_e1rm_kg: z
          .number()
          .positive()
          .describe("Target estimated 1RM in kg (not lb)."),
        target_date: z
          .string()
          .optional()
          .describe("Optional ISO date (YYYY-MM-DD) to hit the target by."),
      },
    },
    (args) =>
      guard(ctx, "set_goal", async () => {
        const targetDate = args.target_date
          ? assertIsoDate(args.target_date, "target_date")
          : null;
        const exercise = await requireExercise(db, args.exercise_id);

        // For reporting only; the write itself is a single atomic upsert on
        // the (user_id, exercise_id) unique constraint.
        const { data: previous, error: prevError } = await db.client
          .from("goals")
          .select("target_e1rm_kg, target_date")
          .eq("user_id", db.ownerId)
          .eq("exercise_id", args.exercise_id)
          .maybeSingle();
        if (prevError) throw new Error(`previous goal: ${prevError.message}`);

        const row = must(
          await db.client
            .from("goals")
            .upsert(
              {
                user_id: db.ownerId,
                exercise_id: args.exercise_id,
                target_e1rm_kg: args.target_e1rm_kg,
                target_date: targetDate,
              },
              { onConflict: "user_id,exercise_id" },
            )
            .select("id, target_e1rm_kg, target_date")
            .single(),
          "upsert goal",
        ) as { id: string; target_e1rm_kg: number; target_date: string | null };

        return jsonResult({
          goal_id: row.id,
          exercise_id: exercise.id,
          exercise_name: exercise.name,
          target_e1rm_kg: row.target_e1rm_kg,
          target_date: row.target_date,
          replaced_goal: previous, // null when this is the first goal
        });
      }),
  );
}
