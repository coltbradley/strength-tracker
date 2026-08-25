import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must, requireExercise } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerSetTrainingMax(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "set_training_max",
    {
      title: "Set training max",
      description:
        "Record a training max for an exercise, in kg, effective from a date " +
        "(default today). History is kept: a new effective date adds a row, the " +
        "same date overwrites. %TM prescriptions resolve against the TM current " +
        "on the relevant date. Returns the previous current TM and the new value.",
      inputSchema: {
        exercise_id: z
          .string()
          .min(1)
          .describe(
            "Exercise id slug (e.g. 'Barbell_Squat'). Use search_exercises to find it.",
          ),
        value_kg: z
          .number()
          .positive()
          .describe("Training max in kg (not lb)."),
        effective_date: z
          .string()
          .regex(ISO_DATE, "must be an ISO date (YYYY-MM-DD)")
          .optional()
          .describe("ISO date the TM takes effect. Default: today."),
      },
    },
    (args) =>
      guard(ctx, "set_training_max", async () => {
        const exercise = await requireExercise(db, args.exercise_id);
        const effectiveDate =
          args.effective_date ?? new Date().toISOString().slice(0, 10);

        const { data: previous, error: prevError } = await db.client
          .from("v_current_tm")
          .select("value_kg, effective_date")
          .eq("user_id", db.ownerId)
          .eq("exercise_id", args.exercise_id)
          .maybeSingle();
        if (prevError) throw new Error(`previous TM: ${prevError.message}`);

        const row = must(
          await db.client
            .from("training_maxes")
            .upsert(
              {
                user_id: db.ownerId,
                exercise_id: args.exercise_id,
                value_kg: args.value_kg,
                effective_date: effectiveDate,
              },
              { onConflict: "user_id,exercise_id,effective_date" },
            )
            .select("value_kg, effective_date")
            .single(),
          "upsert training max",
        ) as { value_kg: number; effective_date: string };

        return jsonResult({
          exercise_id: exercise.id,
          exercise_name: exercise.name,
          previous_current_tm: previous, // null when none existed
          new_tm: {
            value_kg: row.value_kg,
            effective_date: row.effective_date,
          },
        });
      }),
  );
}
