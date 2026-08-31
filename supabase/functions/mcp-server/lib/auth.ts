// Who is calling, and are they allowed to.
//
// MCP clients (Claude Desktop, claude.ai, ChatGPT, anything speaking the
// protocol) authenticate with a static `Authorization: Bearer <token>` header.
// They have no Supabase session to offer, so the token IS the identity: it is
// hashed and looked up in `mcp_tokens`, which maps it to a user id. Every tool
// then filters and stamps that id.
//
// Only the SHA-256 of a token is ever stored. A database leak yields digests,
// not working credentials. Tokens are minted by scripts/issue-mcp-token.mjs.
//
// LEGACY OWNER TOKEN: the pre-multi-user deployment authenticated with a single
// MCP_SECRET mapped to a single OWNER_USER_ID. Both still work, so an existing
// Claude Desktop config keeps running across this deploy with nothing to
// change. Issue a real token per person and drop the env vars when convenient.

import { getClient } from "./db.ts";
import { log } from "./log.ts";

/** The authenticated caller. `label` is for logs only, never for authorization. */
export interface Caller {
  userId: string;
  label: string;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Compare via SHA-256 digests so both sides are fixed-length, then XOR every
// byte. No early exit, so timing reveals nothing about where a mismatch is.
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da.charCodeAt(i) ^ db.charCodeAt(i);
  }
  return diff === 0;
}

/** 401 that tells a client HOW to authenticate, per RFC 9110. Clients render
 *  this far better than a bare 401, and MCP hosts use it to prompt for a key. */
function unauthorized(detail: string): Response {
  return new Response(JSON.stringify({ error: "Unauthorized", detail }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": 'Bearer realm="strength-tracker"',
    },
  });
}

function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  // Scheme is case-insensitive per RFC 9110. Some clients send the token in
  // x-api-key instead (ChatGPT custom connectors, a few MCP hosts), so accept
  // that too rather than failing a caller that is doing nothing wrong.
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();
  return (req.headers.get("x-api-key") ?? "").trim();
}

/**
 * Resolve the caller, or return a ready-to-send 401/500.
 *
 * The token lookup and the `last_used_at` stamp are ONE statement: an UPDATE
 * that returns the row it matched. That keeps authentication to a single round
 * trip while still leaving an audit trail of which credential is live.
 */
export async function resolveCaller(
  req: Request,
  requestId: string,
): Promise<Caller | Response> {
  const token = bearerToken(req);
  if (token.length === 0) {
    return unauthorized("Send Authorization: Bearer <token>.");
  }

  // Legacy single-user secret, checked first so it costs no database round trip.
  const legacySecret = Deno.env.get("MCP_SECRET");
  const legacyUser = Deno.env.get("OWNER_USER_ID");
  if (legacySecret && legacyUser && (await timingSafeEqual(token, legacySecret))) {
    return { userId: legacyUser, label: "legacy owner token" };
  }

  let client;
  try {
    client = getClient();
  } catch (err) {
    log("error", "auth_misconfigured", {
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response(JSON.stringify({ error: "Server is not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const hash = await sha256Hex(token);
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("mcp_tokens")
    .update({ last_used_at: now })
    .eq("token_sha256", hash)
    .is("revoked_at", null)
    // expires_at is NULL for every token a person pastes into an MCP client,
    // and set only on the short-lived ones the coach function mints per turn.
    // A permanent token must keep working exactly as before, so the filter has
    // to accept null rather than compare it.
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .select("user_id, label")
    .maybeSingle();

  if (error) {
    // A lookup failure is a server problem, not a credential problem. Saying
    // "unauthorized" here would send someone hunting a token that is fine.
    log("error", "auth_lookup_failed", {
      request_id: requestId,
      error: error.message,
    });
    return new Response(
      JSON.stringify({ error: "Could not verify credentials", request_id: requestId }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  if (!data) {
    log("warn", "auth_rejected", { request_id: requestId });
    return unauthorized("Unknown or revoked token.");
  }

  const row = data as { user_id: string; label: string };
  return { userId: row.user_id, label: row.label };
}
