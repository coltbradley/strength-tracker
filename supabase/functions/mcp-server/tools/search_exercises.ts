import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

export function registerSearchExercises(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "search_exercises",
    {
      title: "Search exercises",
      description:
        "Search the global exercise library (800+ entries from free-exercise-db) by " +
        "name or id slug, optionally filtered by equipment and primary muscle. Use " +
        "this to find the exact exercise_id required by every other tool. Ids are " +
        "slugs like 'Barbell_Squat'.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Substring to match against exercise name or id slug, case-insensitive (e.g. 'bench press').",
          ),
        equipment: z
          .string()
          .optional()
          .describe(
            "Exact equipment filter (e.g. 'barbell', 'dumbbell', 'body only', 'cable', 'machine').",
          ),
        muscle: z
          .string()
          .optional()
          .describe(
            "Primary muscle filter (e.g. 'quadriceps', 'chest', 'lats', 'hamstrings').",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Max results to return. Default 20, max 50."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "search_exercises", async () => {
        // Strip PostgREST or() delimiters so user input can't break the filter.
        const q = args.query.trim().replace(/[,()%]/g, " ");
        const slugQ = q.replace(/\s+/g, "_");

        let query = db.client
          .from("exercises")
          .select("id, name, primary_muscles, equipment, mechanic, category")
          .or(`name.ilike.%${q}%,id.ilike.%${slugQ}%`);
        if (args.equipment) query = query.eq("equipment", args.equipment);
        if (args.muscle)
          query = query.contains("primary_muscles", [args.muscle]);

        const rows = must(
          await query.order("name").limit(args.limit),
          "search exercises",
        );
        return jsonResult({ count: rows.length, exercises: rows });
      }),
  );
}
