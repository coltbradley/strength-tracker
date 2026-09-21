import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import { HEALTH_DOWN, HEALTH_OK, mcpHealthStatus } from "./health.ts";

Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-not-used-here");

Deno.test(
  "stub ping success is 200 and the ok body has no user data",
  async () => {
    const code = await mcpHealthStatus(async () => {});
    assertEquals(code, 200);
    assertEquals(Object.keys(HEALTH_OK).sort(), [
      "server",
      "status",
      "transport",
    ]);
    assertEquals(HEALTH_OK.status, "ok");
  },
);

Deno.test("missing env is 503 even if ping would succeed", async () => {
  const prevUrl = Deno.env.get("SUPABASE_URL");
  const prevKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.delete("SUPABASE_URL");
  try {
    const code = await mcpHealthStatus(async () => {});
    assertEquals(code, 503);
    assertEquals(HEALTH_DOWN.status, "unavailable");
    assertEquals(
      JSON.stringify(HEALTH_DOWN).includes("Missing required env"),
      false,
    );
  } finally {
    if (prevUrl !== undefined) Deno.env.set("SUPABASE_URL", prevUrl);
    if (prevKey !== undefined) {
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", prevKey);
    }
  }
});

Deno.test(
  "ping throw is 503 and the body does not carry the error",
  async () => {
    const code = await mcpHealthStatus(async () => {
      throw new Error("password authentication failed for user postgres");
    });
    assertEquals(code, 503);
    assertEquals(
      JSON.stringify(HEALTH_DOWN).includes("password authentication failed"),
      false,
    );
  },
);
