// Pull endurance activities into `activities`. E0 of the endurance layer.
//
// Two providers, and any combination of them: both, either, or neither. A
// provider with no credentials row is SKIPPED and reported, never an error --
// "nothing connected" is a supported state of this deployment, not a failure,
// and the strength app must not notice either way.
//
// Deliberately POLLING rather than webhooks. A webhook needs a public
// unauthenticated endpoint and a shared secret to defend, and nothing in this
// app blocks on a run appearing within seconds. The attack surface is not worth
// the latency nobody is waiting on.
//
// Deduplication is NOT here. It is a before-insert trigger in Postgres
// (20260907030000), so a third provider added later cannot forget it and so it
// is testable without a running edge function.
import { createClient } from "@supabase/supabase-js";
import { fetchIntervals, fetchStrava, ProviderError } from "./providers.ts";
import type { NormalizedActivity } from "./normalize.ts";

type Provider = "intervals_icu" | "strava";
const PROVIDERS: Provider[] = ["intervals_icu", "strava"];

/** Poll re-reads a window before the newest row held, because upstream
 * activities get EDITED after upload (a renamed run, a corrected sport, a
 * device re-upload). Syncing strictly after the newest start time would never
 * see any of it. 48 hours is cheap: the unique key makes a re-read a no-op. */
const OVERLAP_MS = 48 * 60 * 60 * 1000;
const BACKFILL_DEFAULT_DAYS = 400;
const PAGE_LIMIT = 200;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
}

async function resolveUser(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const jwt = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
  if (!jwt) return null;
  const client = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    },
  );
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ fn: "endurance-sync", ...fields }));
}

interface ProviderResult {
  provider: Provider;
  status: "not_connected" | "disabled" | "ok" | "failed";
  fetched?: number;
  inserted?: number;
  /** Rows the trigger marked as already held from the other source. */
  duplicates?: number;
  /** Of the rows inserted, how many carried a descent measurement. */
  with_descent?: number;
  error?: string;
  retryable?: boolean;
}

/**
 * Write a provider's page.
 *
 * `on conflict do nothing` on (user_id, source, external_id) is what makes a
 * replay free, the same guarantee the outbox gets from client-generated uuids.
 * Chunked because PostgREST has a request size, and one chunk failing must not
 * lose the ones that already landed -- there are no transactions here.
 */
async function writeActivities(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  rows: NormalizedActivity[],
): Promise<{ inserted: number; duplicates: number; withDescent: number }> {
  let inserted = 0;
  let duplicates = 0;
  let withDescent = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100).map((r) => ({ ...r, user_id: userId }));
    const { data, error } = await db
      .from("activities")
      .upsert(chunk, {
        onConflict: "user_id,source,external_id",
        ignoreDuplicates: true,
      })
      .select("id, duplicate_of, descent_m");
    if (error) throw new Error(`write: ${error.message}`);
    for (const row of data ?? []) {
      inserted += 1;
      if ((row as { duplicate_of: string | null }).duplicate_of !== null) {
        duplicates += 1;
      }
      if ((row as { descent_m: number | null }).descent_m !== null) {
        withDescent += 1;
      }
    }
  }
  return { inserted, duplicates, withDescent };
}

async function runProvider(
  db: ReturnType<typeof serviceClient>,
  userId: string,
  provider: Provider,
  since: Date,
): Promise<ProviderResult> {
  const { data: cred, error } = await db
    .from("integration_credentials")
    .select("secret, enabled, external_id")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(`credentials: ${error.message}`);
  if (!cred) return { provider, status: "not_connected" };
  if (!cred.enabled) return { provider, status: "disabled" };

  const secret = {
    ...(cred.secret as Record<string, unknown>),
    ...(cred.external_id ? { athlete_id: cred.external_id } : {}),
  };
  try {
    const fetched = provider === "intervals_icu"
      ? await fetchIntervals(secret, { since, limit: PAGE_LIMIT })
      : await fetchStrava(secret, { since, limit: PAGE_LIMIT });
    const w = await writeActivities(db, userId, fetched.activities);
    await db
      .from("integration_credentials")
      .update({
        last_sync_at: new Date().toISOString(),
        last_error: null,
        ...(fetched.externalId ? { external_id: fetched.externalId } : {}),
      })
      .eq("user_id", userId)
      .eq("provider", provider);
    return {
      provider,
      status: "ok",
      fetched: fetched.activities.length,
      inserted: w.inserted,
      duplicates: w.duplicates,
      with_descent: w.withDescent,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const retryable = e instanceof ProviderError ? e.retryable : true;
    // Recorded on the credentials row so a broken connection is visible
    // without reading logs. One provider failing must not stop the other:
    // that is the whole point of "both, either, or neither".
    await db
      .from("integration_credentials")
      .update({ last_error: msg.slice(0, 500) })
      .eq("user_id", userId)
      .eq("provider", provider);
    return { provider, status: "failed", error: msg, retryable };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await resolveUser(req);
  if (!userId) return json({ error: "Sign in first" }, 401);

  const path = new URL(req.url).pathname;
  const mode = path.endsWith("/backfill") ? "backfill" : "poll";

  let body: { since?: unknown } = {};
  try {
    body = (await req.json()) as { since?: unknown };
  } catch {
    // A bodyless POST is the ordinary poll.
  }

  const db = serviceClient();
  const startedAt = Date.now();

  let since: Date;
  if (mode === "backfill") {
    const asked = typeof body.since === "string" ? new Date(body.since) : null;
    since = asked && !Number.isNaN(asked.getTime())
      ? asked
      : new Date(Date.now() - BACKFILL_DEFAULT_DAYS * 86_400_000);
  } else {
    const { data } = await db
      .from("activities")
      .select("started_at")
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const newest = data?.started_at ? new Date(data.started_at as string) : null;
    since = newest
      ? new Date(newest.getTime() - OVERLAP_MS)
      : new Date(Date.now() - BACKFILL_DEFAULT_DAYS * 86_400_000);
  }

  const results: ProviderResult[] = [];
  for (const p of PROVIDERS) {
    try {
      results.push(await runProvider(db, userId, p, since));
    } catch (e) {
      // A failure that is OURS (the database, not the provider) rather than
      // one provider's. Still does not stop the other.
      results.push({
        provider: p,
        status: "failed",
        error: e instanceof Error ? e.message : String(e),
        retryable: true,
      });
    }
  }

  const connected = results.filter(
    (r) => r.status === "ok" || r.status === "failed",
  );
  const inserted = results.reduce((n, r) => n + (r.inserted ?? 0), 0);
  const withDescent = results.reduce((n, r) => n + (r.with_descent ?? 0), 0);

  log({
    user_id: userId,
    mode,
    since: since.toISOString(),
    ms: Date.now() - startedAt,
    results,
  });

  // NOTHING CONNECTED IS 200. It is a state of this deployment, not an error,
  // and a client polling on foreground must not learn to treat it as one.
  if (connected.length === 0) {
    return json({
      mode,
      connected: [],
      inserted: 0,
      note:
        "No endurance source is connected. Add a row to integration_credentials to connect one.",
      results,
    });
  }

  // If every connected provider failed, say so with a status a caller can
  // retry on. A partial success is a success: one source working is the point.
  const allFailed = connected.every((r) => r.status === "failed");
  return json(
    {
      mode,
      inserted,
      // Surfaced because the whole descent differentiator depends on it and a
      // backfill that lands zero of them should be found in E0 rather than in
      // E5, when the eccentric rules quietly have nothing to gate on.
      inserted_with_descent: withDescent,
      results,
    },
    allFailed ? 502 : 200,
  );
});
