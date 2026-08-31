import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must, requireExercise } from "../lib/db.ts";
import { guard, jsonResult, type RequestContext } from "../lib/errors.ts";

/**
 * Notes that belong to a movement rather than to one day of it.
 *
 * Every other note in this system is scoped to an occasion — a planned day, a
 * logged set, a session. A cue like "front foot stays flat" is true every time
 * the exercise comes up, and had nowhere to live but retyped onto each day.
 */
export function registerExerciseNotes(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_exercise_notes",
    {
      title: "Get exercise notes",
      description:
        "Standing notes on movements: cues, restrictions, setup details that " +
        "apply every time that exercise comes up, as opposed to the notes on " +
        "one planned day or one logged set. Read these before writing a " +
        "program or advising on form — they are where 'my left shoulder does " +
        "not like this angle' lives.",
      inputSchema: {
        exercise_id: z
          .string()
          .optional()
          .describe("Just this one. Omit for every note the user has."),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "get_exercise_notes", async () => {
        let q = db.client
          .from("exercise_notes")
          .select("exercise_id, note, updated_at")
          .eq("user_id", db.ownerId)
          .order("updated_at", { ascending: false });
        if (args.exercise_id) q = q.eq("exercise_id", args.exercise_id);
        const rows = must(await q, "exercise notes");
        return jsonResult({
          data: { notes: rows },
          metadata: { count: rows.length },
        });
      }),
  );

  server.registerTool(
    "set_exercise_note",
    {
      title: "Set exercise note",
      description:
        "Write the standing note for one movement. Last-write-wins and it " +
        "REPLACES what was there, so read it first with get_exercise_notes " +
        "and keep what still applies rather than overwriting someone's own " +
        "cue with a fresh sentence. Write an empty string to clear it. Use " +
        "this for things true of the movement every time; a note about one " +
        "session belongs on that session, and the lifter writes those.",
      inputSchema: {
        exercise_id: z
          .string()
          .describe("Exercise id (use search_exercises to find it)."),
        note: z
          .string()
          .max(2000)
          .describe("The note. Empty string clears it."),
      },
    },
    (args) =>
      guard(ctx, "set_exercise_note", async () => {
        // Another user's custom exercise must report as unknown, never as
        // forbidden — the service role bypasses RLS, so this is the gate.
        const ex = await requireExercise(db, args.exercise_id);
        const note = args.note.trim();

        if (note === "") {
          const { error } = await db.client
            .from("exercise_notes")
            .delete()
            .eq("user_id", db.ownerId)
            .eq("exercise_id", args.exercise_id);
          if (error) throw new Error(`clear note: ${error.message}`);
          return jsonResult({
            data: { exercise_id: args.exercise_id, name: ex.name, note: null },
            metadata: { note: "Cleared." },
          });
        }

        const { error } = await db.client.from("exercise_notes").upsert(
          {
            user_id: db.ownerId,
            exercise_id: args.exercise_id,
            note,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,exercise_id" },
        );
        if (error) throw new Error(`set note: ${error.message}`);
        return jsonResult({
          data: { exercise_id: args.exercise_id, name: ex.name, note },
        });
      }),
  );
}
