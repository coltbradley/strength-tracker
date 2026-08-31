// The ONLY place a Supabase client is constructed. MCP requests authenticate
// with a bearer token, not a Supabase Auth session, so there is no auth.uid()
// on this path: the service role bypasses RLS and every tool must filter and
// stamp user_id = db.ownerId itself (see docs/decisions.md).
//
// MULTI-USER: `ownerId` is now resolved PER REQUEST from the presented token
// (lib/auth.ts), not read once from an env var. The service-role client is
// still cached for the life of the isolate — it holds no user state — but the
// `Db` handed to tools is built fresh per request and must never be cached.
// Caching it is exactly how one user's id would leak into another user's call
// in a warm isolate, and every tool trusts `ownerId` completely.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ToolError } from "./errors.ts";

export interface Db {
  client: SupabaseClient;
  /** The user this request acts as. Resolved from the bearer token. */
  ownerId: string;
}

let cachedClient: SupabaseClient | null = null;

/**
 * The service-role client. Stateless with respect to who is calling, so it is
 * safe (and worth it) to reuse across requests in one isolate.
 */
export function getClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  const missing = [
    !url && "SUPABASE_URL",
    !serviceKey && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}`);
  }

  cachedClient = createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

/** The per-request handle every tool receives. Never cache this. */
export function dbFor(userId: string): Db {
  return { client: getClient(), ownerId: userId };
}

/** Shape of the ownership join, which PostgREST returns as an object or an
 *  array depending on how it resolved the relationship. */
interface OwnedExerciseRow {
  id: string;
  source: string;
  exercise_owners: { user_id: string }[] | { user_id: string } | null;
}

/**
 * The one visibility rule: a shared library row is everybody's, a 'custom' row
 * is only its owner's. Every read of `exercises` in this server goes through
 * this, because the server is the service role and RLS is not there to help.
 */
function canSee(row: OwnedExerciseRow, ownerId: string): boolean {
  if (row.source !== "custom") return true;
  const owners = row.exercise_owners;
  const list = owners === null ? [] : Array.isArray(owners) ? owners : [owners];
  return list.some((o) => o.user_id === ownerId);
}

/**
 * Filter a list of exercise ids down to the ones this caller can see.
 *
 * The bulk counterpart to requireExercise, for tools that validate many ids at
 * once. upsert_program used to check existence with a bare
 * `.select("id").in("id", ids)`, which as the service role sees every row in
 * the table: another account's custom exercise passed the check, went into the
 * program, and came back out of get_program by name. Ids are name-derived
 * slugs, so they are guessable rather than secret.
 *
 * Returns the visible ids. Callers report the remainder as UNKNOWN — never as
 * forbidden, which would confirm the id exists.
 */
export async function visibleExerciseIds(
  db: Db,
  exerciseIds: string[],
): Promise<Set<string>> {
  if (exerciseIds.length === 0) return new Set();
  const { data, error } = await db.client
    .from("exercises")
    .select("id, source, exercise_owners(user_id)")
    .in("id", exerciseIds);
  if (error) throw new Error(`look up exercises: ${error.message}`);
  const rows = (data ?? []) as OwnedExerciseRow[];
  return new Set(rows.filter((r) => canSee(r, db.ownerId)).map((r) => r.id));
}

/**
 * Assert an exercise id exists AND that this caller can see it, returning its
 * row. Throws a user-facing ToolError pointing at search_exercises otherwise.
 *
 * The seeded library is shared; a custom exercise belongs to one person. This
 * runs as the service role, which bypasses RLS, so the ownership check happens
 * here or nowhere — and this is the single gate every tool that names an
 * exercise (programs, training maxes, goals) goes through. Another person's
 * custom lift reports as unknown rather than as forbidden: confirming that an
 * id exists but belongs to someone else is itself a leak.
 */
export async function requireExercise(
  db: Db,
  exerciseId: string,
): Promise<{ id: string; name: string }> {
  const { data, error } = await db.client
    .from("exercises")
    .select("id, name, source, exercise_owners(user_id)")
    .eq("id", exerciseId)
    .maybeSingle();
  if (error) throw new Error(`look up exercise: ${error.message}`);

  const row = data as (OwnedExerciseRow & { name: string }) | null;

  if (row === null || !canSee(row, db.ownerId)) {
    throw new ToolError(
      `Unknown exercise_id '${exerciseId}'. Call search_exercises to find the correct id slug.`,
    );
  }
  return { id: row.id, name: row.name };
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
