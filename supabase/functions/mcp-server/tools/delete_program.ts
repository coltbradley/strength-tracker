// Delete a program (its planned workouts and prescriptions cascade).
// Logged training data is never touched: sessions/sets survive with their
// planned_workout_id / prescription_id nulled by the FKs. Unconfirmed
// programs delete freely (a bad parse is routine); confirmed programs
// require the explicit flag after user approval in chat.

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

export function registerDeleteProgram(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "delete_program",
    {
      title: "Delete program",
      description:
        "Delete a program and its planned workouts/prescriptions. Logged " +
        "sessions and sets are NEVER touched (their links to the plan are " +
        "nulled). Unconfirmed programs delete freely; deleting a CONFIRMED " +
        "program requires confirm_delete_confirmed=true, only after the user " +
        "explicitly approved it in chat. Find ids via the program list " +
        "returned by upsert_program/confirm_program, or ask the user.",
      inputSchema: {
        program_id: z.string().uuid().describe("The program's id."),
        confirm_delete_confirmed: z
          .boolean()
          .default(false)
          .describe(
            "Must be true to delete a CONFIRMED program. Set only after the " +
              "user approved the deletion in chat.",
          ),
      },
    },
    (args) =>
      guard(ctx, "delete_program", async () => {
        const rows = must(
          await db.client
            .from("programs")
            .select("id, name, confirmed_at")
            .eq("user_id", db.ownerId)
            .eq("id", args.program_id),
          "program lookup",
        ) as { id: string; name: string; confirmed_at: string | null }[];
        if (rows.length === 0) {
          throw new ToolError(`No program with id ${args.program_id}.`);
        }
        const program = rows[0];
        if (program.confirmed_at !== null && !args.confirm_delete_confirmed) {
          throw new ToolError(
            `'${program.name}' is CONFIRMED — the active plan. Ask the user ` +
              "to approve the deletion, then retry with " +
              "confirm_delete_confirmed=true.",
          );
        }
        const { error } = await db.client
          .from("programs")
          .delete()
          .eq("user_id", db.ownerId)
          .eq("id", args.program_id);
        if (error) throw new Error(`delete program: ${error.message}`);
        return jsonResult({
          deleted: true,
          program_id: program.id,
          name: program.name,
          was_confirmed: program.confirmed_at !== null,
          note: "Logged sessions/sets are untouched; their plan links are nulled.",
        });
      }),
  );
}
