// MCP server for the strength tracker, as a Supabase Edge Function.
//
// Transport choice: the official TypeScript SDK's
// WebStandardStreamableHTTPServerTransport (@modelcontextprotocol/sdk >= 1.25,
// server/webStandardStreamableHttp.js). It speaks web-standard Request/Response
// so it runs natively on the Deno edge runtime — no Node req/res shimming, no
// need for the mcp-lite alternative. Stateless: sessionIdGenerator is omitted
// (no session ids generated or required) and enableJsonResponse returns plain
// JSON instead of opening an SSE stream. A fresh McpServer + transport pair is
// built per POST; no state survives between requests.

// The .js runtime specifiers don't type-resolve under Deno (the package's
// "./*" export maps types to a nonexistent *.js.d.ts), so point the checker
// at the extensionless paths explicitly.
// @ts-types="@modelcontextprotocol/sdk/server/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// @ts-types="@modelcontextprotocol/sdk/server/webStandardStreamableHttp"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { requireAuth } from "./lib/auth.ts";
import { getDb } from "./lib/db.ts";
import type { RequestContext } from "./lib/errors.ts";
import { log } from "./lib/log.ts";
import { registerConfirmProgram } from "./tools/confirm_program.ts";
import { registerDeleteProgram } from "./tools/delete_program.ts";
import { registerGetGoalProgress } from "./tools/get_goal_progress.ts";
import { registerGetLiftHistory } from "./tools/get_lift_history.ts";
import { registerGetRecentSessions } from "./tools/get_recent_sessions.ts";
import { registerManageExercises } from "./tools/manage_exercises.ts";
import { registerSearchExercises } from "./tools/search_exercises.ts";
import { registerSetGoal } from "./tools/set_goal.ts";
import { registerSetTrainingMax } from "./tools/set_training_max.ts";
import { registerUpsertProgram } from "./tools/upsert_program.ts";

function buildServer(ctx: RequestContext): McpServer {
  const server = new McpServer({ name: "strength-tracker", version: "1.0.0" });
  const db = getDb();
  // Read tools (readOnlyHint: true).
  registerSearchExercises(server, db, ctx);
  registerGetLiftHistory(server, db, ctx);
  registerGetRecentSessions(server, db, ctx);
  registerGetGoalProgress(server, db, ctx);
  // Write tools. NEVER add tools that write sessions or sets: those tables
  // belong to the PWA (see CLAUDE.md hard rules).
  registerUpsertProgram(server, db, ctx);
  registerConfirmProgram(server, db, ctx);
  registerDeleteProgram(server, db, ctx);
  registerSetTrainingMax(server, db, ctx);
  registerSetGoal(server, db, ctx);
  registerManageExercises(server, db, ctx);
  return server;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = crypto.randomUUID();
  const started = performance.now();
  const ctx: RequestContext = { requestId };
  let method: string | undefined;
  let tool: string | undefined;

  const finish = (outcome: "ok" | "error", error?: string): void => {
    log(outcome === "ok" ? "info" : "error", "request", {
      request_id: requestId,
      rpc_method: method,
      tool,
      duration_ms: Math.round(performance.now() - started),
      outcome,
      ...(error ? { error } : {}),
    });
  };

  try {
    // Auth before anything else.
    const denied = await requireAuth(req, requestId);
    if (denied) {
      finish("error", denied.status === 401 ? "unauthorized" : "misconfigured");
      return denied;
    }

    // Stateless streamable HTTP: POST only. No SSE stream to GET.
    if (req.method !== "POST") {
      finish("error", `method not allowed: ${req.method}`);
      return new Response(
        JSON.stringify({
          error: "Method not allowed. POST JSON-RPC to this endpoint.",
        }),
        {
          status: 405,
          headers: { "content-type": "application/json", allow: "POST" },
        },
      );
    }

    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch {
      finish("error", "invalid JSON body");
      return json(400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error: invalid JSON" },
        id: null,
      });
    }

    const rpc = parsedBody as {
      method?: string;
      params?: { name?: string };
    } | null;
    method = rpc?.method;
    tool = method === "tools/call" ? rpc?.params?.name : undefined;

    const server = buildServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(req, { parsedBody });

    finish(ctx.toolError ? "error" : "ok", ctx.toolError);
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "request_unhandled_error", {
      request_id: requestId,
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    finish("error", message);
    return json(500, {
      error: "Internal server error",
      request_id: requestId,
    });
  }
});
