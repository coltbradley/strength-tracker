import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must, requireExercise } from "../lib/db.ts";
import { assertIsoDate, todayIso } from "../lib/dates.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

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
          .optional()
          .describe(
            "ISO date (YYYY-MM-DD) the TM takes effect. Default: today. A " +
              "future date is allowed but is not current until it arrives.",
          ),
      },
    },
    (args) =>
      guard(ctx, "set_training_max", async () => {
        // One "today" for both the default stamp and the future-date check:
        // the lifter's home timezone (app_config.tz), the same date
        // v_current_tm compares against. Resolved once so the two cannot
        // straddle midnight, and so an evening set cannot stamp tomorrow.
        const today = await todayIso(db);
        const effectiveDate = args.effective_date
          ? assertIsoDate(args.effective_date, "effective_date")
          : today;
        const exercise = await requireExercise(db, args.exercise_id);

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

        // A future-dated TM is legal but invisible to v_current_tm (and to
        // %TM resolution) until the date arrives — make that explicit.
        const isFuture = effectiveDate > today;
        return jsonResult({
          exercise_id: exercise.id,
          exercise_name: exercise.name,
          previous_current_tm: previous, // null when none existed
          new_tm: {
            value_kg: row.value_kg,
            effective_date: row.effective_date,
          },
          ...(isFuture
            ? {
                note:
                  `Not current until ${effectiveDate}; ` +
                  (previous
                    ? `current TM remains ${previous.value_kg} kg until then.`
                    : "no TM is current until then."),
              }
            : {}),
        });
      }),
  );
}
