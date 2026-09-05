// Protocol interop. Proves this endpoint behaves like an MCP server to a client
// that is not Claude Desktop: the JSON-RPC handshake, tool discovery, CORS,
// the unauthenticated probe, and the shape of a rejection.
//
// Calls the handler directly, so there is no port, no network and no Supabase.
// That is exactly why lib/handler.ts is separate from index.ts.
//
// The legacy owner token is used because it resolves without a database round
// trip; the per-user token path is the same code past resolveCaller().

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";

const SECRET = "test-secret-do-not-use";
const USER = "00000000-0000-4000-8000-000000000001";

Deno.env.set("MCP_SECRET", SECRET);
Deno.env.set("OWNER_USER_ID", USER);
// Never contacted by initialize/tools/list, but getClient() asserts they exist.
Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-not-used-here");

const { handleRequest } = await import("./handler.ts");

const URL_ = "https://example.test/functions/v1/mcp-server";

function rpc(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${SECRET}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "interop-test", version: "0.0.0" },
  },
};

Deno.test("initialize returns a protocol version and server info", async () => {
  const res = await handleRequest(rpc(INITIALIZE));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.jsonrpc, "2.0");
  assertEquals(body.result.serverInfo.name, "strength-tracker");
  // A client refuses to proceed without this.
  assertEquals(typeof body.result.protocolVersion, "string");
  assertEquals(typeof body.result.capabilities.tools, "object");
});

Deno.test("tools/list advertises every tool with a usable schema", async () => {
  const res = await handleRequest(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  assertEquals(res.status, 200);
  const { result } = await res.json();
  const names: string[] = result.tools.map((t: { name: string }) => t.name);

  // The full published surface. A tool vanishing from this list is a silent
  // break for every client that already knows its name.
  for (const expected of [
    "search_exercises",
    "get_lift_history",
    "get_recent_sessions",
    "get_goal_progress",
    "get_program",
    // The index that makes get_program's program_id usable. Without it the
    // model can only ever read the NEWEST program, which stopped being the
    // right one when the PWA started writing confirmed programs of its own.
    "list_programs",
    "upsert_program",
    "confirm_program",
    "delete_program",
    "set_training_max",
    "set_goal",
    "add_exercise",
    "update_exercise",
    "delete_exercise",
  ]) {
    assertEquals(names.includes(expected), true, `missing tool: ${expected}`);
  }

  for (const tool of result.tools) {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.inputSchema.type, "object");
  }
});

Deno.test("a browser preflight succeeds without credentials", async () => {
  // OPTIONS carries no Authorization header by design. Answering it with 401
  // is what makes a connector fail with an unexplained "cannot connect".
  const res = await handleRequest(
    new Request(URL_, {
      method: "OPTIONS",
      headers: {
        origin: "https://chatgpt.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertStringIncludes(res.headers.get("access-control-allow-headers") ?? "", "authorization");
  assertStringIncludes(res.headers.get("access-control-allow-headers") ?? "", "mcp-protocol-version");
});

Deno.test("responses carry CORS so a browser client can read them", async () => {
  const res = await handleRequest(rpc(INITIALIZE));
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertStringIncludes(res.headers.get("access-control-expose-headers") ?? "", "mcp-session-id");
  await res.body?.cancel();
});

Deno.test("/health answers without a credential and leaks nothing", async () => {
  const res = await handleRequest(new Request(`${URL_}/health`, { method: "GET" }));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "ok");
  // No user ids, no counts, no configuration.
  assertEquals(Object.keys(body).sort(), ["server", "status", "transport"]);
});

Deno.test("no token is 401 and says how to authenticate", async () => {
  const res = await handleRequest(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(INITIALIZE),
    }),
  );
  assertEquals(res.status, 401);
  // RFC 9110: without this a client cannot tell auth apart from a server fault,
  // and MCP hosts use it to decide whether to prompt for a key.
  assertStringIncludes(res.headers.get("www-authenticate") ?? "", "Bearer");
  // CORS on the failure too, or a browser client sees an opaque network error
  // instead of the 401 that would tell its user what to fix.
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  await res.body?.cancel();
});

Deno.test("an unreachable token store is 503, never 401", async () => {
  // The distinction matters more than it looks. A token this server cannot
  // LOOK UP is not a token it has judged invalid: answering 401 would send
  // someone hunting a credential that is perfectly good, and would train a
  // client to discard a working key. SUPABASE_URL points at a closed port here,
  // which is exactly the outage being modelled.
  const res = await handleRequest(rpc(INITIALIZE, { authorization: "Bearer nope" }));
  assertEquals(res.status, 503);
  const body = await res.json();
  assertStringIncludes(body.error, "verify");
  // Still traceable to a log line.
  assertEquals(typeof body.request_id, "string");
});

Deno.test("x-api-key is accepted, for clients with no custom-header field", async () => {
  const res = await handleRequest(
    new Request(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": SECRET,
      },
      body: JSON.stringify(INITIALIZE),
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.result.serverInfo.name, "strength-tracker");
});

Deno.test("GET is refused with Allow, not with a hang or a 500", async () => {
  const res = await handleRequest(
    new Request(URL_, { method: "GET", headers: { authorization: `Bearer ${SECRET}` } }),
  );
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "POST");
  await res.body?.cancel();
});

Deno.test("malformed JSON gets a JSON-RPC parse error, not a crash", async () => {
  const res = await handleRequest(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: "{ not json",
    }),
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.code, -32700);
});
