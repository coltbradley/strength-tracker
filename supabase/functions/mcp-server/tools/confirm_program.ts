import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import {
  guard,
  jsonResult,
  ToolError,
  type RequestContext,
} from "../lib/errors.ts";

export function registerConfirmProgram(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "confirm_program",
    {
      title: "Confirm program",
      description:
        "Mark a program written by upsert_program as confirmed, making it active " +
        "for the app. REQUIRES EXPLICIT USER APPROVAL IN CHAT FIRST: only call " +
        "this after the user has reviewed the program summary and clearly said " +
        "to confirm it. Confirmation is one-way.",
      inputSchema: {
        program_id: z
          .string()
          .uuid()
          .describe("The program_id returned by upsert_program."),
      },
    },
    (args) =>
      guard(ctx, "confirm_program", async () => {
        const { data, error } = await db.client
          .from("programs")
          .update({ confirmed_at: new Date().toISOString() })
          .eq("id", args.program_id)
          .eq("user_id", db.ownerId)
          .is("confirmed_at", null)
          .select("id, name, confirmed_at");
        if (error) throw new Error(`confirm program: ${error.message}`);

        if (data && data.length > 0) {
          const row = data[0] as {
            id: string;
            name: string;
            confirmed_at: string;
          };
          return jsonResult({
            program_id: row.id,
            name: row.name,
            confirmed_at: row.confirmed_at,
            status: "confirmed",
          });
        }

        // Nothing updated: distinguish "already confirmed" from "not found".
        const { data: existing, error: lookupError } = await db.client
          .from("programs")
          .select("id, name, confirmed_at")
          .eq("id", args.program_id)
          .eq("user_id", db.ownerId)
          .maybeSingle();
        if (lookupError)
          throw new Error(`program lookup: ${lookupError.message}`);
        if (!existing) {
          throw new ToolError(`No program found with id ${args.program_id}.`);
        }
        return jsonResult({
          program_id: existing.id,
          name: existing.name,
          confirmed_at: existing.confirmed_at,
          status: "already_confirmed",
        });
      }),
  );
}
