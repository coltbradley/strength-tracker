import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import {
  guard,
  jsonResult,
  type RequestContext,
  ToolError,
} from "../lib/errors.ts";
import { safeFilterTerm } from "../lib/filters.ts";

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
        "slugs like 'Barbell_Squat'.\n\n" +
        "Each result carries the user's NOTES on that movement when they have " +
        "any: `note` is the standing cue that applies every time (a " +
        "restriction, a setup detail), and `recent_set_notes` is what they " +
        "actually wrote while lifting it. Read them before programming the " +
        "exercise — 'left shoulder does not like this angle' is the difference " +
        "between a good prescription and one they will skip.",
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
        // Strip everything reserved by the PostgREST or() grammar so user
        // input cannot break the filter. This used to miss `"` and `\`, and an
        // unbalanced quote made PostgREST fail to parse the filter at all —
        // surfacing to the model as "Unexpected server error" and to the logs
        // as an error with a stack trace. See lib/filters.ts.
        const q = safeFilterTerm(args.query);
        if (q === "") {
          throw new ToolError(
            `Search query '${args.query}' has no searchable characters — it is ` +
              "punctuation the exercise-name filter cannot use. Search for a " +
              "word from the movement's name, e.g. 'bench press'.",
          );
        }
        const slugQ = q.replace(/\s+/g, "_");

        // The seeded library is shared; a CUSTOM exercise belongs to one
        // person. This runs as the service role, which bypasses RLS, so the
        // scoping is explicit here or it does not happen: without it every
        // caller would see everyone's custom lifts.
        const owned = must(
          await db.client
            .from("exercise_owners")
            .select("exercise_id")
            .eq("user_id", db.ownerId),
          "own custom exercises",
        ) as { exercise_id: string }[];
        const mine = owned.map((o) => o.exercise_id);

        let query = db.client
          .from("exercises")
          .select("id, name, primary_muscles, equipment, mechanic, category")
          .or(`name.ilike.%${q}%,id.ilike.%${slugQ}%`)
          .or(
            mine.length > 0
              ? `source.neq.custom,id.in.(${mine.join(",")})`
              : "source.neq.custom",
          );
        if (args.equipment) query = query.eq("equipment", args.equipment);
        if (args.muscle)
          query = query.contains("primary_muscles", [args.muscle]);

        const rows = must(
          await query.order("name").limit(args.limit),
          "search exercises",
        ) as unknown as { id: string }[];

        // Notes travel WITH the exercise. Programming a movement without
        // seeing what the lifter has said about it is how a plan ends up
        // prescribing the thing their shoulder does not like — and making the
        // assistant fetch history per exercise to find that out is a round
        // trip it will usually skip.
        const ids = rows.map((r) => r.id);
        const [standing, setNotes] = ids.length === 0
          ? [[], []]
          : await Promise.all([
              must(
                await db.client
                  .from("exercise_notes")
                  .select("exercise_id, note")
                  .eq("user_id", db.ownerId)
                  .in("exercise_id", ids),
                "exercise notes",
              ) as unknown as { exercise_id: string; note: string }[],
              // The lifter's own words from the gym floor, newest first. Capped
              // hard: this is context for a decision, not a transcript.
              must(
                await db.client
                  .from("set_notes")
                  .select("note, updated_at, sets!inner(exercise_id)")
                  .eq("user_id", db.ownerId)
                  .in("sets.exercise_id", ids)
                  .order("updated_at", { ascending: false })
                  .limit(60),
                "set notes",
              ) as unknown as {
                note: string;
                updated_at: string;
                sets: { exercise_id: string };
              }[],
            ]);

        const standingBy = new Map(standing.map((n) => [n.exercise_id, n.note]));
        const recentBy = new Map<string, string[]>();
        for (const n of setNotes) {
          const id = n.sets?.exercise_id;
          if (!id) continue;
          const list = recentBy.get(id) ?? [];
          if (list.length < 3) {
            list.push(n.note);
            recentBy.set(id, list);
          }
        }

        // The seeded library carries a dozen near-identical variants of most
        // movements — eleven lateral raises, five bench presses — in
        // alphabetical order. Handing that back unranked is how a program ends
        // up prescribing three squats that are the same squat. What the lifter
        // has ACTUALLY trained is the signal: it is the movement they have a
        // bar loaded for, a history in, and a working weight for.
        const trained = ids.length === 0
          ? []
          : (must(
              await db.client
                .from("v_live_sets")
                .select("exercise_id, performed_at")
                .eq("user_id", db.ownerId)
                .in("exercise_id", ids)
                .order("performed_at", { ascending: false })
                .limit(400),
              "trained exercises",
            ) as unknown as { exercise_id: string; performed_at: string }[]);

        const lastTrained = new Map<string, string>();
        const setCount = new Map<string, number>();
        for (const t of trained) {
          if (!lastTrained.has(t.exercise_id))
            lastTrained.set(t.exercise_id, t.performed_at);
          setCount.set(t.exercise_id, (setCount.get(t.exercise_id) ?? 0) + 1);
        }

        const enriched = rows.map((r) => {
          const note = standingBy.get(r.id);
          const recent = recentBy.get(r.id);
          const last = lastTrained.get(r.id);
          return {
            ...r,
            ...(note ? { note } : {}),
            ...(recent && recent.length > 0 ? { recent_set_notes: recent } : {}),
            ...(last
              ? { last_trained: last, logged_sets: setCount.get(r.id) ?? 0 }
              : {}),
          };
        });

        // Trained first, most recent first within that; everything else keeps
        // its name order behind them.
        enriched.sort((a, b) => {
          const at = "last_trained" in a ? (a.last_trained as string) : "";
          const bt = "last_trained" in b ? (b.last_trained as string) : "";
          if (at && bt) return bt.localeCompare(at);
          if (at) return -1;
          if (bt) return 1;
          return 0;
        });

        return jsonResult({
          count: enriched.length,
          exercises: enriched,
          guidance:
            "Results are ordered by what this lifter actually trains: entries " +
            "with `last_trained` are movements they have logged, most recent " +
            "first. PREFER THOSE. The library holds many near-identical " +
            "variants of the same movement, and picking an untrained one " +
            "splits their history and gives them nothing to compare against. " +
            "Never put two variants of the same movement in one session " +
            "unless the coach explicitly asked for both.",
        });
      }),
  );
}
