import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { must } from "../lib/db.ts";
import type { Db } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

/**
 * Trends without recomputation: one read of `v_trend_digest`, computed fresh
 * by SQL at read time from views that already read v_live_sets. Nothing here
 * is stored; this is the same query the coach's per-turn TRENDS line runs.
 *
 * A user with no bodyweight log, no check-ins and no logged working sets gets
 * NO ROW in the view at all — absence, not a row of zeros — so this returns a
 * null trend object with a note, rather than fabricating a flat baseline.
 */

interface Lift {
  exercise_id: string;
  name: string;
  e1rm_latest_kg: number | null;
  e1rm_4w_ago_kg: number | null;
  working_sets_this_week: number;
  working_sets_last_week: number;
}

interface TrendRow {
  user_id: string;
  bw_latest_kg: number | null;
  bw_latest_at: string | null;
  bw_7d_mean_kg: number | null;
  bw_7d_n: number;
  bw_28d_mean_kg: number | null;
  bw_28d_n: number;
  bw_28d_slope_kg_per_week: number | null;
  energy_14d_mean: number | null;
  energy_14d_n: number;
  lifts: Lift[];
}

export function registerGetTrends(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_trends",
    {
      title: "Get trends",
      description:
        "Bodyweight (latest, 7-day and 28-day means with counts, 28-day " +
        "slope in kg/week), energy (14-day mean with count), and the top 5 " +
        "exercises by working sets in the last 8 weeks (each with e1RM now " +
        "vs 4 weeks ago and working sets this week vs last). Computed fresh " +
        "from the log every call — nothing here is stored, so this is always " +
        "current. Every mean carries its own count: avg() skips nulls, so a " +
        "mean of one point is not the same claim as a mean of ten. Use this " +
        "instead of recomputing e1RM or bodyweight trends from " +
        "get_recent_sessions or get_bodyweight by hand.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    () =>
      guard(ctx, "get_trends", async () => {
        const rows = must(
          await db.client
            .from("v_trend_digest")
            .select(
              "user_id, bw_latest_kg, bw_latest_at, bw_7d_mean_kg, bw_7d_n, " +
                "bw_28d_mean_kg, bw_28d_n, bw_28d_slope_kg_per_week, " +
                "energy_14d_mean, energy_14d_n, lifts",
            )
            .eq("user_id", db.ownerId)
            .limit(1),
          "trends",
        ) as unknown as TrendRow[];

        const row = rows[0];
        if (row === undefined) {
          return jsonResult({
            data: { trends: null },
            metadata: {
              note:
                "No bodyweight log, check-ins or logged working sets yet — " +
                "there is nothing to trend, not a trend of zero.",
            },
          });
        }

        return jsonResult({
          data: {
            trends: {
              bodyweight: {
                latest_kg: row.bw_latest_kg,
                latest_at: row.bw_latest_at,
                mean_7d: { mean_kg: row.bw_7d_mean_kg, n: row.bw_7d_n },
                mean_28d: { mean_kg: row.bw_28d_mean_kg, n: row.bw_28d_n },
                slope_kg_per_week: row.bw_28d_slope_kg_per_week,
              },
              energy: {
                mean_14d: row.energy_14d_mean,
                n_14d: row.energy_14d_n,
              },
              lifts: row.lifts,
            },
          },
          metadata: {
            note:
              "A single-session e1RM jump or drop over 20% should be " +
              "checked against set notes and swaps before it is treated as " +
              "a strength change.",
          },
        });
      }),
  );
}
