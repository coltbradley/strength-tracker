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
Deno.env.set("SUPABASE_ANON_KEY", "anon-not-used-here");

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
  const res = await handleRequest(
    rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  );
  assertEquals(res.status, 200);
  const { result } = await res.json();
  const names: string[] = result.tools.map((t: { name: string }) => t.name);

  // The full published surface. A tool vanishing from this list is a silent
  // break for every client that already knows its name.
  for (const expected of [
    "search_exercises",
    // The batched lookup. Six sequential search_exercises calls for one pull
    // day is the latency it exists to remove, so a client that has learned to
    // reach for it must keep finding it.
    "resolve_exercises",
    "get_lift_history",
    "get_recent_sessions",
    // Check-ins: the lifter's own words from the always-available "Check in"
    // button and the readiness panel. Events, not a trend.
    "get_checkins",
    // Both sources v_bodyweight unions: the standalone log and the figure
    // captured at Finish.
    "get_bodyweight",
    "get_goal_progress",
    // Trends without recomputation, and the session diff it is built beside:
    // what changed between the plan and what actually happened, for
    // adapting the next session.
    "get_trends",
    "get_session_diff",
    // The coach's own conclusions, with a check-back date.
    "record_observation",
    "resolve_observation",
    "get_observations",
    // The week as one row. It exists so "how was last week" stops being dozens
    // of set rows added up in a model's head, which was slow and gave a
    // slightly different answer every time it was asked.
    "get_week_summary",
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
  assertStringIncludes(
    res.headers.get("access-control-allow-headers") ?? "",
    "authorization",
  );
  assertStringIncludes(
    res.headers.get("access-control-allow-headers") ?? "",
    "mcp-protocol-version",
  );
});

Deno.test(
  "responses carry CORS so a browser client can read them",
  async () => {
    const res = await handleRequest(rpc(INITIALIZE));
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
    assertStringIncludes(
      res.headers.get("access-control-expose-headers") ?? "",
      "mcp-session-id",
    );
    await res.body?.cancel();
  },
);

Deno.test(
  "/health answers without a credential and leaks nothing",
  async () => {
    const res = await handleRequest(
      new Request(`${URL_}/health`, { method: "GET" }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.status, "ok");
    // No user ids, no counts, no configuration.
    assertEquals(Object.keys(body).sort(), ["server", "status", "transport"]);
  },
);

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
  const res = await handleRequest(
    rpc(INITIALIZE, { authorization: "Bearer nope" }),
  );
  assertEquals(res.status, 503);
  const body = await res.json();
  assertStringIncludes(body.error, "verify");
  // Still traceable to a log line.
  assertEquals(typeof body.request_id, "string");
});

Deno.test(
  "x-api-key is accepted, for clients with no custom-header field",
  async () => {
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
  },
);

Deno.test("GET is refused with Allow, not with a hang or a 500", async () => {
  const res = await handleRequest(
    new Request(URL_, {
      method: "GET",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "POST");
  await res.body?.cancel();
});

Deno.test(
  "malformed JSON gets a JSON-RPC parse error, not a crash",
  async () => {
    const res = await handleRequest(
      new Request(URL_, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SECRET}`,
        },
        body: "{ not json",
      }),
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.code, -32700);
  },
);

Deno.test(
  "protected-resource metadata is served without credentials",
  async () => {
    const res = await handleRequest(
      new Request(`${URL_}/.well-known/oauth-protected-resource`, {
        method: "GET",
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
    const doc = await res.json();
    assertStringIncludes(doc.resource, "/functions/v1/mcp-server");
    assertStringIncludes(doc.authorization_servers[0], "/auth/v1");
  },
);

Deno.test(
  "every 401 points the client at the metadata, so it can start sign-in",
  async () => {
    const res = await handleRequest(
      new Request(URL_, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(INITIALIZE),
      }),
    );
    assertEquals(res.status, 401);
    assertStringIncludes(
      res.headers.get("www-authenticate") ?? "",
      'resource_metadata="http://127.0.0.1:1/functions/v1/mcp-server/.well-known/oauth-protected-resource"',
    );
    await res.body?.cancel();
  },
);

Deno.test(
  "an OAuth token the auth server cannot be asked about is 503, never 401",
  async () => {
    const enc = (v: unknown) =>
      btoa(JSON.stringify(v))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const token = `${enc({ alg: "ES256" })}.${enc({
      sub: USER,
      role: "authenticated",
      client_id: "c1",
    })}.sig`;
    const res = await handleRequest(
      rpc(INITIALIZE, { authorization: `Bearer ${token}` }),
    );
    assertEquals(res.status, 503);
    await res.body?.cancel();
  },
);

Deno.test(
  "a session JWT with no client_id is 401 without contacting anyone",
  async () => {
    const enc = (v: unknown) =>
      btoa(JSON.stringify(v))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    const token = `${enc({ alg: "ES256" })}.${enc({ sub: USER, role: "authenticated" })}.sig`;
    const res = await handleRequest(
      rpc(INITIALIZE, { authorization: `Bearer ${token}` }),
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
  },
);

// What each tool may do to data that already exists. destructive = it can
// delete or overwrite something the lifter or another account already has.
// Additive writes (a new unconfirmed program, a dated training max row that
// does not replace another date) are not destructive. Keep in step with the
// tool's own write; a wrong "false" here removes a confirmation prompt.
const EXPECTED_ANNOTATIONS: Record<
  string,
  { readOnly: boolean; destructive: boolean }
> = {
  search_exercises: { readOnly: true, destructive: false },
  resolve_exercises: { readOnly: true, destructive: false },
  get_lift_history: { readOnly: true, destructive: false },
  get_recent_sessions: { readOnly: true, destructive: false },
  get_checkins: { readOnly: true, destructive: false },
  get_checkin_buckets: { readOnly: true, destructive: false },
  get_bodyweight: { readOnly: true, destructive: false },
  get_injuries: { readOnly: true, destructive: false },
  get_goal_progress: { readOnly: true, destructive: false },
  get_trends: { readOnly: true, destructive: false },
  get_session_diff: { readOnly: true, destructive: false },
  get_observations: { readOnly: true, destructive: false },
  get_volume: { readOnly: true, destructive: false },
  get_training_maxes: { readOnly: true, destructive: false },
  get_week_summary: { readOnly: true, destructive: false },
  get_memory: { readOnly: true, destructive: false },
  list_programs: { readOnly: true, destructive: false },
  get_program: { readOnly: true, destructive: false },
  get_exercise_notes: { readOnly: true, destructive: false },
  list_feedback: { readOnly: true, destructive: false },
  find_similar_days: { readOnly: true, destructive: false },
  get_training_plan: { readOnly: true, destructive: false },
  upsert_program: { readOnly: false, destructive: false },
  confirm_program: { readOnly: false, destructive: false },
  repeat_planned_workout: { readOnly: false, destructive: false },
  confirm_training_plan: { readOnly: false, destructive: false },
  remember: { readOnly: false, destructive: false },
  submit_feedback: { readOnly: false, destructive: false },
  resolve_feedback: { readOnly: false, destructive: false },
  // Additive: a new open observation, never overwriting or deleting one.
  record_observation: { readOnly: false, destructive: false },
  // Marks an existing observation resolved/superseded; it never deletes it
  // or touches anything but the row named by id, so it is not destructive
  // in this table's sense (compare resolve_feedback, the same shape).
  resolve_observation: { readOnly: false, destructive: false },
  add_exercise: { readOnly: false, destructive: false },
  set_goal: { readOnly: false, destructive: true },
  set_training_plan: { readOnly: false, destructive: true },
  set_training_max: { readOnly: false, destructive: true },
  set_exercise_note: { readOnly: false, destructive: true },
  update_planned_workout: { readOnly: false, destructive: true },
  update_exercise: { readOnly: false, destructive: true },
  forget: { readOnly: false, destructive: true },
  delete_program: { readOnly: false, destructive: true },
  delete_exercise: { readOnly: false, destructive: true },
};

Deno.test("every tool declares what it does to existing data", async () => {
  const res = await handleRequest(
    rpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  );
  const { result } = await res.json();
  const names = result.tools.map((t: { name: string }) => t.name).sort();
  assertEquals(names, Object.keys(EXPECTED_ANNOTATIONS).sort());
  for (const tool of result.tools) {
    const expected = EXPECTED_ANNOTATIONS[tool.name];
    assertEquals(
      tool.annotations?.readOnlyHint,
      expected.readOnly,
      `${tool.name} readOnlyHint`,
    );
    assertEquals(
      tool.annotations?.destructiveHint,
      expected.destructive,
      `${tool.name} destructiveHint`,
    );
    // Every tool reads and writes this lifter's own log, never the open web.
    assertEquals(
      tool.annotations?.openWorldHint,
      false,
      `${tool.name} openWorldHint`,
    );
  }
});
