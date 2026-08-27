import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must, requireExercise } from "../lib/db.ts";
import { assertIsoDate } from "../lib/dates.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

// Deliberately UTC, not app_tz(): this is the start of a rolling 90-day
// window, not a calendar day the lifter experiences. A day of slack at the far
// end of the window changes nothing, and nothing keys off it. Only dates that
// are compared against app_tz() dates (training_maxes.effective_date) have to
// agree with the database -- see lib/dates.ts.
function defaultSince(): string {
  return new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

// Chronological sections are fetched newest-first with an explicit limit, then
// reversed. Ordering ascending with a cap (or relying on PostgREST's 1000-row
// default) would silently drop the NEWEST rows — the ones that matter.
async function newestFirst<T>(
  query: {
    order: (
      col: string,
      opts: { ascending: boolean },
    ) => {
      limit: (
        n: number,
      ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
    };
  },
  limit: number,
  what: string,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows = must(
    await query.order("performed_at", { ascending: false }).limit(limit),
    what,
  );
  return { rows: rows.reverse(), truncated: rows.length === limit };
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
        "Full training history for one exercise: raw logged sets, " +
        "best-e1RM-per-session series (Epley, working sets, 1-8 reps), " +
        "prescribed-vs-achieved adherence rows, rest-before-set times, and the " +
        "current training max if one exists. Sections are chronological " +
        "(oldest first) except sets (newest first) and capped at the newest " +
        "rows: sets 500, e1rm_series 365, adherence 500, rest 500; each " +
        "section has a truncated flag that is true when its cap was hit " +
        "(narrow the window with since to see older data). All loads are kg, " +
        "dates ISO 8601.\n\n" +
        "LOADS ARE ALWAYS THE TOTAL SYSTEM LOAD — the whole weight moved in " +
        "one rep. A pair of 30 kg dumbbells is load_kg 60. Tonnage, e1RM and " +
        "adherence are therefore directly comparable across every exercise. " +
        "load_entry says how the lifter EXPRESSED that number, and you should " +
        "quote it back the way they said it: 'per_side' means they entered " +
        "one side and both sides moved together, so report 60 kg as " +
        "'30 x 2'; 'total' means the number is already what they said. " +
        "load_entry NULL means UNKNOWN, not total: the set was logged before " +
        "this convention existed and `sets` is append-only, so it can never " +
        "be corrected. For a NULL-mode dumbbell or unilateral movement, say " +
        "the figure is ambiguous rather than reporting it as fact — and note " +
        "that a run of NULL-mode sets may mix both conventions, so trends " +
        "across that boundary can be an artefact.",
      inputSchema: {
        exercise_id: z
          .string()
          .min(1)
          .describe(
            "Exercise id slug (e.g. 'Barbell_Squat'). Use search_exercises to find it.",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "Only include data on or after this ISO date (YYYY-MM-DD). Default: 90 days ago.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_lift_history", async () => {
        const since = args.since
          ? assertIsoDate(args.since, "since")
          : defaultSince();
        const exercise = await requireExercise(db, args.exercise_id);
        const sinceTs = `${since}T00:00:00Z`;

        const base = (table: string, columns: string) =>
          db.client
            .from(table)
            .select(columns)
            .eq("user_id", db.ownerId)
            .eq("exercise_id", args.exercise_id)
            .gte("performed_at", sinceTs);

        const [sets, e1rm, adherence, rest, tmRes] = await Promise.all([
          // Raw sets stay newest-first (most recent work is what gets read).
          // v_live_sets, not sets: voided sets and discarded sessions must
          // not leak into analysis (every other section already excludes
          // them via its view).
          (async () => {
            const rows = must(
              await base(
                "v_live_sets",
                "id, session_id, prescription_id, set_index, set_type, load_kg, load_entry, reps, performed_at",
              )
                .order("performed_at", { ascending: false })
                .limit(500),
              "sets",
            );
            return { rows, truncated: rows.length === 500 };
          })(),
          newestFirst(
            base(
              "v_session_best_e1rm",
              "session_id, performed_at, best_e1rm_kg",
            ),
            365,
            "e1RM series",
          ),
          newestFirst(
            base(
              "v_adherence",
              "set_id, session_id, prescription_id, set_index, performed_at, " +
                "actual_load_kg, actual_reps, reps_min, reps_max, prescribed_load_kg, " +
                "load_delta_kg, rep_outcome, actual_load_entry, prescribed_load_entry",
            ),
            500,
            "adherence",
          ),
          newestFirst(
            base(
              "v_rest",
              "set_id, session_id, set_index, performed_at, rest_seconds_before",
            ),
            500,
            "rest",
          ),
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
          sets: sets.rows,
          sets_truncated: sets.truncated,
          e1rm_series: e1rm.rows,
          e1rm_series_truncated: e1rm.truncated,
          adherence: adherence.rows,
          adherence_truncated: adherence.truncated,
          rest: rest.rows,
          rest_truncated: rest.truncated,
        });
      }),
  );
}
