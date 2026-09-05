// The week as one row, rather than as a history to add up.
//
// "How many working sets did I do this week" and "did I train what I planned"
// were both answerable only by fetching sets or a program and counting in the
// model's head. That is slow, costs tokens on every ask, and quietly gives a
// slightly different answer each time, which is the worst property a number
// reported to a lifter can have.
//
// v_weekly_summary does the arithmetic in SQL, bucketed in the lifter's own
// timezone, so the answer is the same here and on their screen. This tool is a
// window onto it and nothing more: no counting happens in TypeScript, on
// purpose, because a second implementation of "a working set" is a second
// definition of it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { assertIsoDate, todayIso } from "../lib/dates.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

/** Enough to see a block, short enough that nobody reads a year by accident. */
const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 104;

export function registerGetWeekSummary(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_week_summary",
    {
      title: "Get week summary",
      description:
        "One row per ISO week: sessions finished, working sets, tonnage, " +
        "average session RPE, and planned days against planned days DONE. " +
        "Newest week first. Ask this before reading sessions or sets to " +
        "answer anything shaped like 'how was last week' or 'am I keeping up " +
        "with the plan' — it is one query where those are dozens of rows to " +
        "add up, and it counts the same way the app does.\n\n" +
        "planned_days and planned_days_done are two COUNTS and are " +
        "deliberately not a percentage. A week with no plan has no adherence " +
        "at all, and a ratio renders that as zero, which reads as total " +
        "failure rather than as nothing having been asked. Say '3 of 4' or " +
        "'nothing was scheduled', never '0%'. Days with nothing programmed " +
        "into them are not counted as owed: an empty day is one nobody wrote, " +
        "not a workout they skipped.\n\n" +
        "sessions counts only FINISHED sessions. An open one is someone " +
        "mid-workout or an abandoned start, and neither is training yet. " +
        "tonnage_kg is load x reps over working sets, and loads are totals " +
        "(a pair of 30 kg dumbbells is 60).",
      inputSchema: {
        weeks: z
          .number()
          .int()
          .min(1)
          .max(MAX_WEEKS)
          .optional()
          .describe(
            `How many weeks back from today. Default ${DEFAULT_WEEKS}, when \`since\` is not given.`,
          ),
        since: z
          .string()
          .optional()
          .describe(
            "Only weeks STARTING on or after this ISO date (YYYY-MM-DD), so " +
              "a week already underway when that date fell is excluded whole. " +
              "Give this or `weeks`; naming both takes the later date.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_week_summary", async () => {
        const since =
          args.since === undefined ? null : assertIsoDate(args.since, "since");

        // Same shape as get_volume, and deliberately so: two tools that window
        // the same calendar differently would answer "the last four weeks"
        // with two different sets of weeks. The default lives here rather than
        // in the zod schema because a schema default is indistinguishable from
        // a value the caller typed, and would clip an older `since` back to it.
        const weeks = args.weeks ?? (since === null ? DEFAULT_WEEKS : null);
        const floors: string[] = [];
        if (since !== null) floors.push(since);
        if (weeks !== null) {
          // Counted from the LIFTER's today. week_start is bucketed with
          // app_tz(user_id), so a floor computed off the server's UTC clock
          // puts the two ends of one comparison in different calendars.
          const from = new Date(`${await todayIso(db)}T00:00:00Z`);
          from.setUTCDate(from.getUTCDate() - weeks * 7);
          floors.push(from.toISOString().slice(0, 10));
        }
        floors.sort();
        const from = floors[floors.length - 1];

        const rows = must(
          await db.client
            .from("v_weekly_summary")
            .select(
              "week_start, sessions, working_sets, tonnage_kg, " +
                "avg_session_rpe, planned_days, planned_days_done",
            )
            .eq("user_id", db.ownerId)
            .gte("week_start", from)
            .order("week_start", { ascending: false })
            .limit(MAX_WEEKS),
          "week summary",
        );

        return jsonResult({
          data: { weeks: rows },
          metadata: {
            count: rows.length,
            since: from,
            note:
              "A week with no row had no training and no plan at all. " +
              "avg_session_rpe is null when nothing was rated, which is " +
              "common and is not the same as an easy week.",
          },
        });
      }),
  );
}
