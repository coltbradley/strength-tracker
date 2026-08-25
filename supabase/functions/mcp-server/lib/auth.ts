// Static bearer token auth. The function is deployed --no-verify-jwt, so this
// is the only gate. Token lives in the MCP_SECRET function secret and in
// Claude Desktop's mcp-remote --header config. Never log it.

import { log } from "./log.ts";

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

// Compare via SHA-256 digests so both sides are fixed-length, then XOR every
// byte. No early exit, so timing reveals nothing about where a mismatch is.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da[i] ^ db[i];
  }
  return diff === 0;
}

/**
 * Returns null when the request carries the correct bearer token, otherwise a
 * ready-to-send 401 response.
 */
export async function requireAuth(
  req: Request,
  requestId: string,
): Promise<Response | null> {
  const secret = Deno.env.get("MCP_SECRET");
  if (!secret) {
    log("error", "auth_misconfigured", {
      request_id: requestId,
      error: "MCP_SECRET is not set",
    });
    return new Response(JSON.stringify({ error: "Server is not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";

  if (token.length === 0 || !(await timingSafeEqual(token, secret))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}
