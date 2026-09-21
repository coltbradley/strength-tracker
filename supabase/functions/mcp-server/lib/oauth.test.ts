import { assertEquals } from "jsr:@std/assert@^1";

Deno.env.set("SUPABASE_URL", "https://ref.supabase.co");
Deno.env.set("SUPABASE_ANON_KEY", "anon-not-used-here");

const {
  callerFromClaims,
  decodeJwtPayload,
  looksLikeJwt,
  protectedResourceMetadata,
  resourceMetadataUrl,
  verifyOAuthToken,
} = await import("./oauth.ts");

const USER = "00000000-0000-4000-8000-000000000002";

function jwt(payload: Record<string, unknown>): string {
  const enc = (v: unknown) =>
    btoa(JSON.stringify(v))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "ES256", typ: "JWT" })}.${enc(payload)}.signature`;
}

Deno.test("existing credential shapes are never mistaken for a JWT", () => {
  assertEquals(looksLikeJwt("stl_" + "A".repeat(43)), false);
  assertEquals(looksLikeJwt(crypto.randomUUID() + crypto.randomUUID()), false);
  assertEquals(looksLikeJwt("test-secret-do-not-use"), false);
  assertEquals(looksLikeJwt(jwt({ sub: USER })), true);
});

Deno.test("a payload that is not JSON decodes to null, not a throw", () => {
  assertEquals(decodeJwtPayload("aaa.bm90IGpzb24.sig"), null);
  assertEquals(decodeJwtPayload(jwt({ sub: USER }))?.sub, USER);
});

Deno.test(
  "only an OAuth token with a client and a user becomes a caller",
  () => {
    assertEquals(
      callerFromClaims({ sub: USER, role: "authenticated", client_id: "c1" }),
      { userId: USER, label: "oauth client c1", ephemeral: false },
    );
    // A plain PWA session token: no client_id. Refused on purpose.
    assertEquals(callerFromClaims({ sub: USER, role: "authenticated" }), null);
    assertEquals(
      callerFromClaims({ sub: USER, role: "anon", client_id: "c1" }),
      null,
    );
    assertEquals(
      callerFromClaims({ sub: "", role: "authenticated", client_id: "c1" }),
      null,
    );
  },
);

Deno.test("a token the auth server accepts resolves to its user", async () => {
  const token = jwt({ sub: USER, role: "authenticated", client_id: "c1" });
  const result = await verifyOAuthToken(token, "req-1", () =>
    Promise.resolve({ data: { user: { id: USER } }, error: null }),
  );
  assertEquals(result, {
    userId: USER,
    label: "oauth client c1",
    ephemeral: false,
  });
});

Deno.test(
  "a token whose claims disagree with the auth server is rejected",
  async () => {
    const token = jwt({ sub: USER, role: "authenticated", client_id: "c1" });
    const result = await verifyOAuthToken(token, "req-2", () =>
      Promise.resolve({ data: { user: { id: "someone-else" } }, error: null }),
    );
    assertEquals(result, "rejected");
  },
);

Deno.test(
  "an auth server that says no is rejected; one we cannot reach is unavailable",
  async () => {
    const token = jwt({ sub: USER, role: "authenticated", client_id: "c1" });
    assertEquals(
      await verifyOAuthToken(token, "req-3", () =>
        Promise.resolve({
          data: { user: null },
          error: { status: 401, name: "AuthApiError" },
        }),
      ),
      "rejected",
    );
    assertEquals(
      await verifyOAuthToken(token, "req-4", () =>
        Promise.resolve({
          data: { user: null },
          error: { status: 0, name: "AuthRetryableFetchError" },
        }),
      ),
      "unavailable",
    );
    assertEquals(
      await verifyOAuthToken(token, "req-5", () =>
        Promise.reject(new Error("socket hang up")),
      ),
      "unavailable",
    );
  },
);

Deno.test(
  "a session token without client_id is rejected before any network call",
  async () => {
    let called = false;
    const result = await verifyOAuthToken(
      jwt({ sub: USER, role: "authenticated" }),
      "req-6",
      () => {
        called = true;
        return Promise.resolve({ data: { user: { id: USER } }, error: null });
      },
    );
    assertEquals(result, "rejected");
    assertEquals(called, false);
  },
);

Deno.test("metadata names this resource and the project's auth server", () => {
  const doc = protectedResourceMetadata();
  assertEquals(doc.resource, "https://ref.supabase.co/functions/v1/mcp-server");
  assertEquals(doc.authorization_servers, ["https://ref.supabase.co/auth/v1"]);
  assertEquals(doc.bearer_methods_supported, ["header"]);
  assertEquals(
    resourceMetadataUrl(),
    "https://ref.supabase.co/functions/v1/mcp-server/.well-known/oauth-protected-resource",
  );
});
