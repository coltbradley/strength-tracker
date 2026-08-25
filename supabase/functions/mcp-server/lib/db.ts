// The ONLY place a Supabase client is constructed. MCP requests authenticate
// with the bearer token, not a Supabase Auth session, so there is no
// auth.uid() on this path: the service role client is pinned to OWNER_USER_ID
// and every tool must filter/stamp user_id = ownerId (see docs/decisions.md).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ToolError } from "./errors.ts";

export interface Db {
  client: SupabaseClient;
  ownerId: string;
}

let cached: Db | null = null;

export function getDb(): Db {
  if (cached) return cached;

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ownerId = Deno.env.get("OWNER_USER_ID");

  const missing = [
    !url && "SUPABASE_URL",
    !serviceKey && "SUPABASE_SERVICE_ROLE_KEY",
    !ownerId && "OWNER_USER_ID",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }

  cached = {
    client: createClient(url!, serviceKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    ownerId: ownerId!,
  };
  return cached;
}

/**
 * Assert an exercise id exists, returning its row. Throws a user-facing
 * ToolError pointing at search_exercises when it does not.
 */
export async function requireExercise(
  db: Db,
  exerciseId: string,
): Promise<{ id: string; name: string }> {
  const { data, error } = await db.client
    .from("exercises")
    .select("id, name")
    .eq("id", exerciseId)
    .maybeSingle();
  if (error) throw new Error(`look up exercise: ${error.message}`);
  if (!data) {
    throw new ToolError(
      `Unknown exercise_id '${exerciseId}'. Call search_exercises to find the correct id slug.`,
    );
  }
  return data;
}

/**
 * Unwrap a PostgREST result, throwing on error. Thrown errors are treated as
 * unexpected by the guard in errors.ts: full detail is logged server-side,
 * the client gets a generic message plus request id.
 */
export function must<T>(
  res: { data: T | null; error: { message: string } | null },
  what: string,
): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: no data returned`);
  return res.data;
}
