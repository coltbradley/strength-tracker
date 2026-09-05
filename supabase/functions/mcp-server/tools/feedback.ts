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

/**
 * The assistant's way of saying "I could not do that".
 *
 * Every other tool here either reads the log or writes a plan. None of them
 * had anywhere to put the thing that happens constantly in practice: a coach
 * screenshot describing something the schema cannot express, a question the
 * available tools cannot answer, a shape the parser had to flatten. That went
 * into a chat message and died there.
 *
 * Deliberately NOT a general note store. `kind` is a closed set and `title` is
 * short, because the value of this table is that it can be read at a glance
 * later, not that it can hold anything.
 */
export function registerFeedback(
  server: McpServer,
  db: Db,
  ctx: RequestContext,
): void {
  server.registerTool(
    "submit_feedback",
    {
      title: "Submit feedback",
      description:
        "File a feature request, bug, data gap or question against the app " +
        "itself. Use this whenever you cannot do something the user asked " +
        "for because the tools or the schema do not support it — a " +
        "prescription shape you had to flatten, a metric you were asked for " +
        "and could not compute, a tool you needed and did not have. Tell the " +
        "user you have filed it; do not file silently, and do not file the " +
        "same thing twice in one conversation. This is NOT for notes about " +
        "training: coach notes belong on the planned workout, and the " +
        "lifter's own notes are theirs to write in the app.",
      inputSchema: {
        kind: z
          .enum(["feature", "bug", "data_gap", "question"])
          .describe(
            "'feature': the app cannot do it yet. 'bug': it can, and it did " +
              "the wrong thing. 'data_gap': the schema cannot express " +
              "something the coach or user said. 'question': you need a " +
              "decision from the owner before this can be built.",
          ),
        title: z
          .string()
          .min(1)
          .max(200)
          .describe(
            "One line, specific enough to act on months later. 'Cannot " +
              "express AMRAP sets', not 'set problem'.",
          ),
        detail: z
          .string()
          .optional()
          .describe("What is needed, and why the current shape cannot do it."),
        context: z
          .string()
          .optional()
          .describe(
            "What you were doing when you hit this — the coach's actual " +
              "wording, the question asked, the tool call you wanted. A " +
              "request without its context is a wish; with it, it is a spec.",
          ),
      },
    },
    (args) =>
      guard(ctx, "submit_feedback", async () => {
        const row = must(
          await db.client
            .from("feedback")
            .insert({
              user_id: db.ownerId,
              kind: args.kind,
              title: args.title.trim(),
              detail: args.detail ?? null,
              context: args.context ?? null,
              source: "claude",
            })
            .select("id, created_at"),
          "feedback",
        ) as unknown as { id: string; created_at: string }[];

        return jsonResult({
          data: { id: row[0]?.id ?? null, kind: args.kind, title: args.title },
          metadata: {
            note:
              "Filed. Tell the user what you recorded and why, in one " +
              "sentence — a request they never hear about is the same as no " +
              "request. Do not file this again in this conversation.",
          },
        });
      }),
  );

  server.registerTool(
    "list_feedback",
    {
      title: "List feedback",
      description:
        "Everything filed against the app, newest first. Read this BEFORE " +
        "filing, so the same gap is not recorded five times, and when the " +
        "user asks what is outstanding.",
      inputSchema: {
        include_resolved: z
          .boolean()
          .default(false)
          .describe("Include entries already dealt with. Default false."),
        n: z.number().int().min(1).max(100).default(25),
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      guard(ctx, "list_feedback", async () => {
        let q = db.client
          .from("feedback")
          .select("id, kind, title, detail, context, source, created_at, resolved_at")
          .eq("user_id", db.ownerId)
          .order("created_at", { ascending: false })
          .limit(args.n);
        if (!args.include_resolved) q = q.is("resolved_at", null);
        const rows = must(await q, "feedback");
        return jsonResult({ count: rows.length, feedback: rows });
      }),
  );

  server.registerTool(
    "resolve_feedback",
    {
      title: "Resolve feedback",
      description:
        "Mark a filed item dealt with — built, fixed, or decided against. " +
        "Only after the user says so: resolving is their call, not yours, " +
        "and an entry resolved on a guess is a request that silently " +
        "disappeared. Nothing is ever deleted; the record of having asked " +
        "stays.",
      inputSchema: {
        id: z.string().uuid().describe("Feedback id, from list_feedback."),
      },
    },
    (args) =>
      guard(ctx, "resolve_feedback", async () => {
        const rows = must(
          await db.client
            .from("feedback")
            .update({ resolved_at: new Date().toISOString() })
            .eq("id", args.id)
            .eq("user_id", db.ownerId)
            .select("id, title"),
          "feedback",
        ) as unknown as { id: string; title: string }[];
        if (rows.length === 0) {
          // ToolError, not Error: this is the caller passing an id that is not
          // theirs (or no longer exists), which is a validation failure the
          // model can act on — the same shape `forget` uses in memory.ts. As a
          // plain Error it was swallowed by the guard's unexpected branch, so
          // the model was told "Unexpected server error. Reference request_id
          // ..." and could only give up, while the logs collected an
          // error-level entry with a stack trace for a mistyped uuid.
          throw new ToolError(
            `No feedback with id ${args.id} belongs to this user. Use ` +
              `list_feedback to get a valid id.`,
          );
        }
        return jsonResult({ data: { resolved: rows[0] } });
      }),
  );
}
