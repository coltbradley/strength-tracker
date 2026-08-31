import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import type { Db } from "../lib/db.ts";
import { must } from "../lib/db.ts";
import { guard, jsonResult, ToolError, type RequestContext } from "../lib/errors.ts";

/**
 * Standing facts about the lifter, between conversations.
 *
 * A conversation remembers itself and nothing else, so the lifter re-explains
 * their shoulder every time. None of that is derivable from the log: no view
 * holds "I train at 6am before work" or "no barbell while travelling".
 *
 * The in-app coach reads these automatically on every turn — they arrive in
 * its context block without a tool call, because memory that has to be fetched
 * is memory that gets forgotten. These tools exist to WRITE it, and to read it
 * from clients that have no such context (Claude Desktop, claude.ai).
 */
export function registerMemory(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "get_memory",
    {
      title: "Get memory",
      description:
        "Standing facts about this lifter: injuries being worked around, " +
        "constraints on equipment or schedule, how they want to be coached. " +
        "Read before programming or advising. NOT their goals — the goals " +
        "table measures those against real sets and get_goal_progress reads " +
        "it.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guard(ctx, "get_memory", async () => {
        const rows = must(
          await db.client
            .from("coach_memory")
            .select("id, kind, fact, updated_at")
            .eq("user_id", db.ownerId)
            .order("kind")
            .order("updated_at", { ascending: false }),
          "memory",
        );
        return jsonResult({ data: { memory: rows }, metadata: { count: rows.length } });
      }),
  );

  server.registerTool(
    "remember",
    {
      title: "Remember",
      description:
        "Record a standing fact about the lifter so it survives this " +
        "conversation.\n\n" +
        "Record what they will not want to repeat: an injury and what it " +
        "rules out, the equipment they actually have, when they train, how " +
        "they like to be coached. Say that you have saved it — a memory they " +
        "do not know about is one they cannot correct.\n\n" +
        "Do NOT record: anything already in the log (what they lifted, when, " +
        "how much — you can read all of it), their goals (set_goal measures " +
        "those properly), or a passing detail from one session. 'Shoulder was " +
        "sore today' belongs in that session's notes, which they write. " +
        "'Left shoulder has impingement, avoid overhead pressing' belongs " +
        "here. Check get_memory first so one fact is not stored five times.",
      inputSchema: {
        kind: z
          .enum(["injury", "constraint", "preference", "context"])
          .describe(
            "injury = something that hurts or is worked around. constraint = " +
              "circumstances (equipment, schedule, travel). preference = how " +
              "they want to be coached or train. context = anything else " +
              "standing and relevant.",
          ),
        fact: z
          .string()
          .min(1)
          .max(300)
          .describe(
            "One fact, in a sentence, in their own terms where you have them. " +
              "Short: this is read in full at the start of every conversation.",
          ),
      },
    },
    (args) =>
      guard(ctx, "remember", async () => {
        const rows = must(
          await db.client
            .from("coach_memory")
            .insert({
              user_id: db.ownerId,
              kind: args.kind,
              fact: args.fact.trim(),
            })
            .select("id, kind, fact"),
          "remember",
        );
        return jsonResult({
          data: { remembered: rows[0] },
          metadata: {
            note:
              "Tell them what you saved, in a few words. Do not save this " +
              "again in this conversation.",
          },
        });
      }),
  );

  server.registerTool(
    "forget",
    {
      title: "Forget",
      description:
        "Remove a standing fact that is no longer true — an injury that " +
        "healed, a constraint that lifted. Only when they say so, or when " +
        "they tell you something that plainly replaces it; a fact that has " +
        "stopped being true is not history worth keeping, it is something " +
        "that will make every future answer worse. Deleting is the only " +
        "destructive thing you can do here, so say what you removed.",
      inputSchema: {
        id: z.string().uuid().describe("Memory id, from get_memory."),
      },
    },
    (args) =>
      guard(ctx, "forget", async () => {
        const rows = must(
          await db.client
            .from("coach_memory")
            .delete()
            .eq("id", args.id)
            .eq("user_id", db.ownerId)
            .select("id, fact"),
          "forget",
        );
        if (rows.length === 0) {
          throw new ToolError(
            `No memory with id ${args.id} belongs to this user. Use ` +
              `get_memory for a valid id.`,
          );
        }
        return jsonResult({ data: { forgot: rows[0] } });
      }),
  );
}
