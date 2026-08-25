import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must, requireExercise } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
          .regex(ISO_DATE, "must be an ISO date (YYYY-MM-DD)")
          .optional()
          .describe("Optional ISO date to hit the target by."),
      },
    },
    (args) =>
      guard(ctx, "set_goal", async () => {
        const exercise = await requireExercise(db, args.exercise_id);

        const { data: replaced, error: deleteError } = await db.client
          .from("goals")
          .delete()
          .eq("user_id", db.ownerId)
          .eq("exercise_id", args.exercise_id)
          .select("target_e1rm_kg, target_date");
        if (deleteError) {
          throw new Error(`replace existing goal: ${deleteError.message}`);
        }

        const row = must(
          await db.client
            .from("goals")
            .insert({
              user_id: db.ownerId,
              exercise_id: args.exercise_id,
              target_e1rm_kg: args.target_e1rm_kg,
              target_date: args.target_date ?? null,
            })
            .select("id, target_e1rm_kg, target_date")
            .single(),
          "insert goal",
        ) as { id: string; target_e1rm_kg: number; target_date: string | null };

        return jsonResult({
          goal_id: row.id,
          exercise_id: exercise.id,
          exercise_name: exercise.name,
          target_e1rm_kg: row.target_e1rm_kg,
          target_date: row.target_date,
          replaced_goal: replaced && replaced.length > 0 ? replaced[0] : null,
        });
      }),
  );
}
