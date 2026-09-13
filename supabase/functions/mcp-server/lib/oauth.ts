// OAuth access tokens from Supabase Auth's OAuth 2.1 server.
//
// This function is a RESOURCE server. Supabase Auth is the authorization
// server: it serves discovery, dynamic client registration, the token
// endpoint, and redirects the lifter to the PWA's consent page. All this file
// does is (1) tell a client where that authorization server is, and (2) turn a
// token it issued into the same Caller the mcp_tokens path produces, so every
// tool downstream is unchanged.
//
// Only a token carrying `client_id` is accepted. A plain PWA session JWT has
// none, and this server runs as the service role with RLS bypassed, so a
// session token lifted from a browser must not double as an MCP credential.
//
// Verification is `auth.getUser(token)`: one round trip, server-side, so a
// revoked grant stops working when Supabase says it does (docs/decisions.md,
// 2026-09-13). Nothing here is cached at module scope except configuration.

import { createClient } from "@supabase/supabase-js";
import type { Caller } from "./auth.ts";
import { log } from "./log.ts";

export type GetUser = (token: string) => Promise<{
  data: { user: { id: string } | null };
  error: { status?: number; name?: string } | null;
}>;

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** stl_ tokens are base64url with no dots and coach tokens are two UUIDs, so a
 *  three-segment dotted token is unambiguous. */
export function looksLikeJwt(token: string): boolean {
  return JWT_SHAPE.test(token);
}

export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const padded =
      part.replaceAll("-", "+").replaceAll("_", "/") +
      "=".repeat((4 - (part.length % 4)) % 4);
    const value = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
      ),
    );
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function callerFromClaims(
  claims: Record<string, unknown>,
): Caller | null {
  const { sub, role, client_id } = claims;
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (role !== "authenticated") return null;
  if (typeof client_id !== "string" || client_id.length === 0) return null;
  return { userId: sub, label: `oauth client ${client_id}` };
}

function supabaseUrl(): string {
  return (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
}

export function resourceUrl(): string {
  return `${supabaseUrl()}/functions/v1/mcp-server`;
}

export function resourceMetadataUrl(): string {
  return `${resourceUrl()}/.well-known/oauth-protected-resource`;
}

/** RFC 9728. Served unauthenticated; says nothing about users. */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: resourceUrl(),
    authorization_servers: [`${supabaseUrl()}/auth/v1`],
    bearer_methods_supported: ["header"],
    resource_name: "Strength Log",
  };
}

const defaultGetUser: GetUser = async (token) => {
  // Per call, never cached: the client carries no identity of its own, but the
  // rule in CLAUDE.md is simpler to keep than to argue exceptions to.
  const client = createClient(
    supabaseUrl(),
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  const { data, error } = await client.auth.getUser(token);
  return {
    data: { user: data.user ? { id: data.user.id } : null },
    error: error ? { status: error.status, name: error.name } : null,
  };
};

export async function verifyOAuthToken(
  token: string,
  requestId: string,
  getUser: GetUser = defaultGetUser,
): Promise<Caller | "rejected" | "unavailable"> {
  const claims = decodeJwtPayload(token);
  const caller = claims ? callerFromClaims(claims) : null;
  if (!caller) {
    log("warn", "oauth_rejected", { request_id: requestId, reason: "claims" });
    return "rejected";
  }
  try {
    const { data, error } = await getUser(token);
    if (error) {
      const unreachable =
        error.name === "AuthRetryableFetchError" ||
        error.status === undefined ||
        error.status === 0 ||
        error.status >= 500;
      log(
        unreachable ? "error" : "warn",
        unreachable ? "oauth_unavailable" : "oauth_rejected",
        {
          request_id: requestId,
          status: error.status,
        },
      );
      return unreachable ? "unavailable" : "rejected";
    }
    // The server vouched for the token; the claims must describe the same user.
    if (!data.user || data.user.id !== caller.userId) {
      log("warn", "oauth_rejected", {
        request_id: requestId,
        reason: "subject",
      });
      return "rejected";
    }
    return caller;
  } catch (err) {
    log("error", "oauth_unavailable", {
      request_id: requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return "unavailable";
  }
}
