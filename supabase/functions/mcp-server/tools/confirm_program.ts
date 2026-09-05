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
          // A discarded program must not be confirmable back into existence.
          .is("discarded_at", null)
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

        // Nothing updated. THREE things can cause that and they are not the
        // same news, so read the row back and say which one happened.
        //
        // This branch used to report every one of them as "already_confirmed",
        // including a discarded draft, whose confirmed_at is null — so the
        // answer was "already confirmed" next to `confirmed_at: null`, which is
        // a contradiction on its face. The consequence was worse than the
        // wording: upsert_program supersedes an unconfirmed program of the same
        // name by discarding it, so retrying confirm with the id from the FIRST
        // parse was told the work was done, and the program the user had just
        // approved was left unconfirmed and off their calendar. An honest error
        // sends the model to get_program/list_programs for the live id.
        const { data: existing, error: lookupError } = await db.client
          .from("programs")
          .select("id, name, confirmed_at, discarded_at")
          .eq("id", args.program_id)
          .eq("user_id", db.ownerId)
          .maybeSingle();
        if (lookupError)
          throw new Error(`program lookup: ${lookupError.message}`);
        if (!existing) {
          throw new ToolError(
            `No program found with id ${args.program_id}. It may belong to ` +
              "another user. Call list_programs for the live ids.",
          );
        }

        const row = existing as {
          id: string;
          name: string;
          confirmed_at: string | null;
          discarded_at: string | null;
        };

        if (row.discarded_at !== null) {
          throw new ToolError(
            `Program ${row.id} ('${row.name}') was deleted or superseded on ` +
              `${row.discarded_at} and cannot be confirmed. If a newer parse ` +
              "replaced it, call list_programs (or get_program with " +
              "include_unconfirmed) to get the id of the program that is " +
              "actually waiting for approval, and confirm THAT one.",
          );
        }

        if (row.confirmed_at === null) {
          // Live, unconfirmed, and the UPDATE still matched nothing: something
          // confirmed and un-confirmed it between the two statements, or a
          // policy changed. Never report it as done.
          throw new ToolError(
            `Program ${row.id} ('${row.name}') is still unconfirmed but the ` +
              "confirmation did not apply. Nothing changed — retry, and if it " +
              "fails again say so rather than treating it as confirmed.",
          );
        }

        return jsonResult({
          program_id: row.id,
          name: row.name,
          confirmed_at: row.confirmed_at,
          status: "already_confirmed",
        });
      }),
  );
}
