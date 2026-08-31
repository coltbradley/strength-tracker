import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

/**
 * Weekly tonnage and working-set counts, and the current training maxes.
 *
 * Both were computed and neither was reachable. v_weekly_volume answers "am I
 * doing more than last month", which is the second question anyone asks after
 * "am I lifting more" — and training maxes could be WRITTEN by
 * set_training_max but never read back, so an assistant adjusting a %TM
 * program had to ask the user what their own training max was.
 */
export function registerGetVolume(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_volume",
    {
      title: "Get volume",
      description:
        "Weekly training volume: tonnage (load x reps, working sets only) and " +
        "working-set counts, per exercise per ISO week, newest week first. " +
        "This is the view for trend questions — whether volume is climbing, " +
        "which lifts carry it, where a deload actually landed. Weeks are " +
        "bucketed in the user's own timezone. Optionally narrowed to one " +
        "exercise.",
      inputSchema: {
        weeks: z
          .number()
          .int()
          .min(1)
          .max(104)
          .default(12)
          .describe("How many weeks back. Default 12."),
        exercise_id: z
          .string()
          .optional()
          .describe("Narrow to one exercise (use search_exercises for the id)."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_volume", async () => {
        const since = new Date(
          Date.now() - args.weeks * 7 * 86_400_000,
        )
          .toISOString()
          .slice(0, 10);
        let q = db.client
          .from("v_weekly_volume")
          .select("exercise_id, week_start, working_sets, tonnage_kg")
          .eq("user_id", db.ownerId)
          .gte("week_start", since)
          .order("week_start", { ascending: false })
          .limit(1000);
        if (args.exercise_id) q = q.eq("exercise_id", args.exercise_id);
        const rows = must(await q, "weekly volume");

        return jsonResult({
          data: { weeks: rows },
          metadata: {
            count: rows.length,
            note:
              "tonnage_kg is load x reps summed over WORKING sets only — " +
              "warmups and tick-only movements contribute nothing, by design. " +
              "Loads are totals (a pair of 30 kg dumbbells is 60).",
          },
        });
      }),
  );

  server.registerTool(
    "get_training_maxes",
    {
      title: "Get training maxes",
      description:
        "The training max currently in effect for every lift that has one. " +
        "Read this BEFORE writing or adjusting a %TM program: a percentage " +
        "means nothing without the number it is a percentage of, and asking " +
        "the user for their own training max when the database holds it is " +
        "the wrong way round.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    () =>
      guard(ctx, "get_training_maxes", async () => {
        const rows = must(
          await db.client
            .from("v_current_tm")
            .select("exercise_id, value_kg, effective_date")
            .eq("user_id", db.ownerId)
            .order("exercise_id"),
          "training maxes",
        );
        return jsonResult({
          data: { training_maxes: rows },
          metadata: {
            count: rows.length,
            note:
              rows.length === 0
                ? "No training maxes set. A %TM prescription cannot resolve " +
                  "to a weight until set_training_max is called for that lift."
                : "kg. effective_date is when it started applying; a " +
                  "future-dated max is not in effect yet and is not listed.",
          },
        });
      }),
  );
}
