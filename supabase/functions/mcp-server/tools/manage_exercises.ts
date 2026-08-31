// Exercise library management: Claude can add and modify exercises. The SEEDED
// library (free-exercise-db + curated) is shared by everyone; a CUSTOM entry
// belongs to the person who made it, via the exercise_owners side table. These
// are the only MCP write tools touching a table that is not itself user-scoped,
// so three rules keep it safe:
//  - add_exercise writes source='custom' so re-running the free-exercise-db
//    seed can never clobber it (that seed only updates its own rows), and
//    claims the row for the caller.
//  - update_exercise flips a seeded row to 'edited' on edit for the same
//    reason: an edited row must survive upstream re-seeds. 'edited' is still
//    a SHARED row — only 'custom' is private — so fixing a typo in the shared
//    library does not take the movement away from everybody else.
//  - a custom exercise someone else owns does not exist as far as this caller
//    is concerned. The service role bypasses RLS, so that has to be enforced
//    HERE; the database policy only covers the PWA path.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import {
  guard,
  jsonResult,
  ToolError,
  type RequestContext,
} from "../lib/errors.ts";

/** An exercise plus its owner row, if it has one (seeded rows do not). */
interface ExerciseLookup {
  id: string;
  name: string;
  source: string;
  exercise_owners: { user_id: string }[] | { user_id: string } | null;
}

/**
 * Refuse to act on a custom exercise belonging to somebody else, and say the
 * same thing as "no such exercise" -- confirming that an id exists but is
 * another person's is itself a leak.
 *
 * A custom row with NO owner is treated as not-mine too. That combination only
 * arises if a claim failed midway, and quietly letting anyone edit it is the
 * wrong recovery.
 */
function assertVisible(row: ExerciseLookup, userId: string, id: string): void {
  if (row.source !== "custom") return;
  const owners = row.exercise_owners;
  const list = owners === null ? [] : Array.isArray(owners) ? owners : [owners];
  if (list.some((o) => o.user_id === userId)) return;
  throw new ToolError(
    `No exercise with id '${id}'. Use search_exercises to find the right slug.`,
  );
}

// Vocabulary from free-exercise-db; the PWA filters on these exact strings
// (e.g. equipment 'barbell'/'machine' turns on the plate calculator).
const MUSCLES = [
  "abdominals",
  "abductors",
  "adductors",
  "biceps",
  "calves",
  "chest",
  "forearms",
  "glutes",
  "hamstrings",
  "lats",
  "lower back",
  "middle back",
  "neck",
  "quadriceps",
  "shoulders",
  "traps",
  "triceps",
] as const;

const EQUIPMENT = [
  "barbell",
  "dumbbell",
  "kettlebells",
  "machine",
  "cable",
  "bands",
  "body only",
  "medicine ball",
  "exercise ball",
  "e-z curl bar",
  "foam roll",
  "other",
] as const;

const CATEGORIES = [
  "strength",
  "stretching",
  "plyometrics",
  "powerlifting",
  "olympic weightlifting",
  "cardio",
] as const;

const fieldSchemas = {
  name: z.string().min(1).describe("Display name, e.g. 'Pallof Press'."),
  primary_muscles: z
    .array(z.enum(MUSCLES))
    .min(1)
    .describe("Primary muscles worked."),
  secondary_muscles: z
    .array(z.enum(MUSCLES))
    .default([])
    .describe("Secondary muscles worked."),
  equipment: z
    .enum(EQUIPMENT)
    .describe(
      "Equipment. 'barbell' and 'machine' enable the app's plate calculator.",
    ),
  mechanic: z.enum(["compound", "isolation"]).optional(),
  force: z.enum(["push", "pull", "static"]).optional(),
  category: z.enum(CATEGORIES).default("strength"),
  level: z.enum(["beginner", "intermediate", "expert"]).default("intermediate"),
};

export function registerManageExercises(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "add_exercise",
    {
      title: "Add exercise",
      description:
        "Add an exercise to the shared library (source='custom'). Search first " +
        "with search_exercises — near-duplicates confuse history and prefill. " +
        "The id slug is derived from the name (e.g. 'Pallof Press' -> " +
        "'Pallof_Press') unless given explicitly.",
      inputSchema: {
        id: z
          .string()
          .regex(/^[0-9a-zA-Z_-]+$/)
          .optional()
          .describe(
            "Id slug. Defaults to the name with spaces as underscores.",
          ),
        ...fieldSchemas,
      },
    },
    (args) =>
      guard(ctx, "add_exercise", async () => {
        const id = args.id ?? args.name.replace(/[^0-9a-zA-Z]+/g, "_");
        if (!/^[0-9a-zA-Z_-]+$/.test(id)) {
          throw new ToolError(
            `Derived id '${id}' is not a valid slug; pass id explicitly.`,
          );
        }
        const { error } = await db.client.from("exercises").insert({
          id,
          name: args.name,
          primary_muscles: args.primary_muscles,
          secondary_muscles: args.secondary_muscles,
          equipment: args.equipment,
          mechanic: args.mechanic ?? null,
          force: args.force ?? null,
          category: args.category,
          level: args.level,
          source: "custom",
        });
        if (error) {
          if (error.code === "23505") {
            throw new ToolError(
              `Exercise id '${id}' already exists. Use update_exercise to ` +
                "modify it, or pick a different id.",
            );
          }
          throw new Error(`insert exercise: ${error.message}`);
        }
        // The database trigger claims a custom exercise for auth.uid(), but
        // this path is the SERVICE ROLE and has no auth.uid(), so the owner row
        // is written here. Without it the exercise belongs to nobody and the
        // read policy hides it from everyone, including the person who just
        // asked for it.
        const claim = await db.client
          .from("exercise_owners")
          .insert({ exercise_id: id, user_id: db.ownerId });
        if (claim.error) {
          // Leaving an unowned row behind would be invisible and confusing.
          await db.client.from("exercises").delete().eq("id", id);
          throw new Error(`claim exercise: ${claim.error.message}`);
        }
        return jsonResult({ id, name: args.name, source: "custom" });
      }),
  );

  server.registerTool(
    "update_exercise",
    {
      title: "Update exercise",
      description:
        "Update fields on an existing exercise (any source). Only the fields " +
        "passed are changed. Editing a seeded row ('free-exercise-db' or " +
        "'curated') re-tags it source='edited' so re-seeds never revert the " +
        "edit; it stays a shared library row. The id " +
        "itself cannot change (history references it), and exercises cannot " +
        "be deleted (logged sets reference them) — rename or repurpose instead.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .describe("Exercise id slug (from search_exercises)."),
        name: fieldSchemas.name.optional(),
        primary_muscles: fieldSchemas.primary_muscles.optional(),
        secondary_muscles: z.array(z.enum(MUSCLES)).optional(),
        equipment: fieldSchemas.equipment.optional(),
        mechanic: z.enum(["compound", "isolation"]).nullable().optional(),
        force: z.enum(["push", "pull", "static"]).nullable().optional(),
        category: z.enum(CATEGORIES).optional(),
        level: z.enum(["beginner", "intermediate", "expert"]).optional(),
      },
    },
    (args) =>
      guard(ctx, "update_exercise", async () => {
        const existing = must(
          await db.client
            .from("exercises")
            .select("id, name, source, exercise_owners(user_id)")
            .eq("id", args.id),
          "exercise lookup",
        ) as ExerciseLookup[];
        if (existing.length === 0) {
          throw new ToolError(
            `No exercise with id '${args.id}'. Use search_exercises to find ` +
              "the right slug, or add_exercise to create it.",
          );
        }
        assertVisible(existing[0], db.ownerId, args.id);

        const patch: Record<string, unknown> = {};
        for (const key of [
          "name",
          "primary_muscles",
          "secondary_muscles",
          "equipment",
          "mechanic",
          "force",
          "category",
          "level",
        ] as const) {
          if (args[key] !== undefined) patch[key] = args[key];
        }
        if (Object.keys(patch).length === 0) {
          throw new ToolError("Pass at least one field to change.");
        }
        // Edited rows must survive a re-seed: both the free-exercise-db and
        // curated seeds only update rows still carrying their own source tag.
        //
        // 'edited', NOT 'custom'. Re-tagging a shared row 'custom' made it
        // private — and private to nobody, because the claim trigger fires on
        // insert and this path is the service role, which has no auth.uid().
        // The row became readable by no one and took every prescription naming
        // it out of the plan. See 20260901010000_edited_exercise_source.sql.
        // A custom row stays custom; its owner is not disturbed by an edit.
        if (existing[0].source !== "custom") patch.source = "edited";

        const { error } = await db.client
          .from("exercises")
          .update(patch)
          .eq("id", args.id);
        if (error) throw new Error(`update exercise: ${error.message}`);

        return jsonResult({
          id: args.id,
          updated: Object.keys(patch),
          previous_source: existing[0].source,
        });
      }),
  );

  server.registerTool(
    "delete_exercise",
    {
      title: "Delete exercise",
      description:
        "Delete a CUSTOM exercise that nothing references (no sets, " +
        "prescriptions, training maxes, or goals) — cleanup for mistaken " +
        "add_exercise calls. Seeded exercises ('free-exercise-db'/'curated') " +
        "can't be deleted (re-seeding restores them), and any referenced " +
        "exercise is protected: history is never orphaned.",
      inputSchema: {
        id: z.string().min(1).describe("Exercise id slug to delete."),
      },
    },
    (args) =>
      guard(ctx, "delete_exercise", async () => {
        const existing = must(
          await db.client
            .from("exercises")
            .select("id, name, source, exercise_owners(user_id)")
            .eq("id", args.id),
          "exercise lookup",
        ) as ExerciseLookup[];
        if (existing.length === 0) {
          throw new ToolError(`No exercise with id '${args.id}'.`);
        }
        assertVisible(existing[0], db.ownerId, args.id);
        if (existing[0].source !== "custom") {
          throw new ToolError(
            `'${args.id}' is a seeded exercise (source ` +
              `'${existing[0].source}') — deleting it would just be undone ` +
              "by the next re-seed. Only custom exercises can be deleted.",
          );
        }
        const { error } = await db.client
          .from("exercises")
          .delete()
          .eq("id", args.id);
        if (error) {
          // FK restraint = something references it; that's the guarantee
          if (error.code === "23503") {
            throw new ToolError(
              `'${args.id}' is referenced by logged sets, prescriptions, ` +
                "training maxes, or goals — it cannot be deleted. Rename it " +
                "with update_exercise instead.",
            );
          }
          throw new Error(`delete exercise: ${error.message}`);
        }
        return jsonResult({
          deleted: true,
          id: args.id,
          name: existing[0].name,
        });
      }),
  );
}
