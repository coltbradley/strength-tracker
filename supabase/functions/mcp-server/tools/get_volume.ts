import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { assertIsoDate } from "../lib/dates.ts";
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
        "bucketed in the user's own timezone. Ask for the window you actually " +
        "want — `weeks` for a lookback, `since` for an absolute date — rather " +
        "than reading a whole history and ignoring most of it. Optionally " +
        "narrowed to one exercise.",
      inputSchema: {
        weeks: z
          .number()
          .int()
          .min(1)
          .max(104)
          .optional()
          .describe(
            "How many weeks back from today. Default 12, when `since` is not given.",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "Only weeks STARTING on or after this ISO date (YYYY-MM-DD). A " +
              "week whose start falls before it is excluded whole, so this " +
              "never returns a part-week. Give this or `weeks`; naming both " +
              "asks for both to hold, and the later date wins.",
          ),
        exercise_id: z
          .string()
          .optional()
          .describe(
            "Narrow to one exercise (use search_exercises for the id).",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_volume", async () => {
        // WHY THE DATE FILTER IS NOT IN A MIGRATION. The timezone-sensitive
        // decision — which calendar week a set belongs to — is already made in
        // SQL: v_weekly_volume buckets with
        // date_trunc('week', performed_at at time zone app_tz(user_id)), the
        // row's OWN owner's zone, so it answers the same on the PWA and
        // service-role paths. `week_start` is therefore a plain date that has
        // already been bucketed correctly, and a floor on it is the same
        // calendar every other view uses. PostgREST pushes the comparison into
        // the WHERE clause, so nothing is fetched and discarded either. Teaching
        // the VIEW a since parameter would mean a second copy of that app_tz
        // expression to keep in step with the first, for no gain.
        const since =
          args.since === undefined ? null : assertIsoDate(args.since, "since");

        // The 12 is the fallback for a caller who named NO window, which is why
        // it is applied here rather than as a zod default. A schema default is
        // indistinguishable from a value the caller typed, so it would have
        // silently clipped every `since` older than twelve weeks back to twelve
        // weeks — the exact question ("volume since January") this parameter
        // exists to answer.
        const weeks = args.weeks ?? (since === null ? 12 : null);
        const floors: string[] = [];
        if (since !== null) floors.push(since);
        if (weeks !== null) {
          floors.push(
            new Date(Date.now() - weeks * 7 * 86_400_000)
              .toISOString()
              .slice(0, 10),
          );
        }
        // Two floors on one column: a caller naming both is asking for both to
        // hold, so the later one is the effective bound. ISO dates sort
        // lexically, which is what makes this a date comparison.
        floors.sort();
        const from = floors[floors.length - 1];

        let q = db.client
          .from("v_weekly_volume")
          .select("exercise_id, week_start, working_sets, tonnage_kg")
          .eq("user_id", db.ownerId)
          .gte("week_start", from)
          .order("week_start", { ascending: false })
          .limit(1000);
        if (args.exercise_id) q = q.eq("exercise_id", args.exercise_id);
        const rows = must(await q, "weekly volume");

        return jsonResult({
          data: { weeks: rows },
          metadata: {
            count: rows.length,
            // Stated because it is the bound actually applied, which is not
            // always the one the caller named: a `weeks` alongside a `since`
            // narrows it, and the absence of both is a 12-week default.
            since: from,
            note:
              "tonnage_kg is load x reps summed over WORKING sets only — " +
              "warmups and tick-only movements contribute nothing, by design. " +
              "Loads are totals (a pair of 30 kg dumbbells is 60). `since` is " +
              "the earliest week START returned, so a week already underway " +
              "when that date fell is not in this answer.",
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
