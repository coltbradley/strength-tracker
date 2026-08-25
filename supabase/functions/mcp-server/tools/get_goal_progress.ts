import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

export function registerGetGoalProgress(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_goal_progress",
    {
      title: "Get goal progress",
      description:
        "Progress toward e1RM goals: target e1RM (kg), optional target date, best " +
        "e1RM in the last 45 days, all-time best e1RM, and percent of target. " +
        "Omit exercise_id to list every goal.",
      inputSchema: {
        exercise_id: z
          .string()
          .optional()
          .describe(
            "Limit to one exercise id slug (e.g. 'Barbell_Deadlift'). Omit for all goals.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_goal_progress", async () => {
        let query = db.client
          .from("v_goal_progress")
          .select(
            "goal_id, exercise_id, exercise_name, target_e1rm_kg, target_date, " +
              "recent_best_e1rm_kg, alltime_best_e1rm_kg, pct_of_target",
          )
          .eq("user_id", db.ownerId);
        if (args.exercise_id) query = query.eq("exercise_id", args.exercise_id);

        const rows = must(await query.order("exercise_id"), "goal progress");
        return jsonResult({ count: rows.length, goals: rows });
      }),
  );
}
