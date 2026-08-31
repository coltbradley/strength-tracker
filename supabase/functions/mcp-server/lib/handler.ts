// The MCP request handler: everything the edge function does, minus the act of
// listening. index.ts is the two-line entry point that serves this.
//
// Split out so the protocol can be TESTED. Importing a module that calls
// Deno.serve at load binds a port and never returns; a plain
// (Request) => Response is callable from a test with no server, no port and no
// network, which is what protocol.test.ts does.
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
import { resolveCaller } from "./auth.ts";
import { dbFor } from "./db.ts";
import type { RequestContext } from "./errors.ts";
import { log } from "./log.ts";
import { registerConfirmProgram } from "../tools/confirm_program.ts";
import { registerDeleteProgram } from "../tools/delete_program.ts";
import { registerFeedback } from "../tools/feedback.ts";
import { registerGetGoalProgress } from "../tools/get_goal_progress.ts";
import { registerGetLiftHistory } from "../tools/get_lift_history.ts";
import { registerGetProgram } from "../tools/get_program.ts";
import { registerGetRecentSessions } from "../tools/get_recent_sessions.ts";
import { registerManageExercises } from "../tools/manage_exercises.ts";
import { registerSearchExercises } from "../tools/search_exercises.ts";
import { registerSetGoal } from "../tools/set_goal.ts";
import { registerSetTrainingMax } from "../tools/set_training_max.ts";
import { registerUpsertProgram } from "../tools/upsert_program.ts";

function buildServer(ctx: RequestContext, userId: string): McpServer {
  const server = new McpServer({ name: "strength-tracker", version: "1.0.0" });
  // Built per request from the token's user. Never hoist this out of here:
  // isolates are reused across callers and every tool trusts db.ownerId.
  const db = dbFor(userId);
  // Read tools (readOnlyHint: true).
  registerSearchExercises(server, db, ctx);
  registerGetLiftHistory(server, db, ctx);
  registerGetRecentSessions(server, db, ctx);
  registerGetGoalProgress(server, db, ctx);
  // Write tools. NEVER add tools that write sessions or sets: those tables
  // belong to the PWA (see CLAUDE.md hard rules).
  registerGetProgram(server, db, ctx);
  registerUpsertProgram(server, db, ctx);
  registerConfirmProgram(server, db, ctx);
  registerDeleteProgram(server, db, ctx);
  registerSetTrainingMax(server, db, ctx);
  registerSetGoal(server, db, ctx);
  registerManageExercises(server, db, ctx);
  registerFeedback(server, db, ctx);
  return server;
}

// CORS. MCP clients that run in a browser (the claude.ai and ChatGPT connector
// UIs, the MCP Inspector) cannot talk to this endpoint without these, and a
// missing header presents as an opaque "failed to connect" with nothing in the
// logs. `mcp-session-id` and `mcp-protocol-version` must be both accepted on
// the way in and EXPOSED on the way out, or a client cannot read the transport
// headers it needs.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, x-api-key, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, www-authenticate",
  "access-control-max-age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

export async function handleRequest(req: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const started = performance.now();
  const ctx: RequestContext = { requestId };
  let method: string | undefined;
  let tool: string | undefined;
  // Which CREDENTIAL was used, never the token itself. Two people share these
  // logs; without it there is no way to tell whose call failed.
  let userLabel: string | undefined;

  const finish = (outcome: "ok" | "error", error?: string): void => {
    log(outcome === "ok" ? "info" : "error", "request", {
      request_id: requestId,
      rpc_method: method,
      tool,
      caller: userLabel,
      duration_ms: Math.round(performance.now() - started),
      outcome,
      ...(error ? { error } : {}),
    });
  };

  try {
    // Preflight, before auth: a browser sends OPTIONS with no Authorization
    // header by design, so answering it with 401 breaks every browser client.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Unauthenticated liveness probe. Deliberately says nothing about who is
    // configured or which users exist -- it exists so uptime checks and the
    // "is this URL an MCP server" question do not need a credential.
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname.endsWith("/health")) {
      return json(200, { status: "ok", server: "strength-tracker", transport: "streamable-http" });
    }

    // Auth before anything else.
    const caller = await resolveCaller(req, requestId);
    if (caller instanceof Response) {
      finish("error", caller.status === 401 ? "unauthorized" : "auth unavailable");
      return withCors(caller);
    }
    userLabel = caller.label;

    // Stateless streamable HTTP: POST only. There is no session to resume, so
    // there is no SSE stream to GET and nothing for DELETE to tear down. 405
    // with `Allow` is the spec's answer for a server that does not offer them,
    // and clients fall back to POST-only cleanly.
    if (req.method !== "POST") {
      finish("error", `method not allowed: ${req.method}`);
      return new Response(
        JSON.stringify({
          error: "Method not allowed. POST JSON-RPC to this endpoint.",
        }),
        {
          status: 405,
          headers: { "content-type": "application/json", allow: "POST", ...CORS },
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

    const server = buildServer(ctx, caller.userId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const response = await transport.handleRequest(req, { parsedBody });

    finish(ctx.toolError ? "error" : "ok", ctx.toolError);
    return withCors(response);
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
}
