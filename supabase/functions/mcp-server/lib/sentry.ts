// Error tracking: Sentry when a DSN is configured, and nothing whatsoever when
// it is not.
//
// This sits ALONGSIDE the structured log line in log.ts, never instead of it.
// The logs are the complete story and cost nothing, but reading them means
// being signed into the Supabase dashboard with analytics working — which
// during the September audit it was not, so an MCP failure was invisible for
// as long as it took someone to ask. Logs are the record; this is the thing
// that reaches a person.
//
// INERT WITHOUT A DSN, and inert here means the SDK is never even loaded. The
// import is dynamic and is only reached once SENTRY_DSN is a non-empty string,
// so with the secret unset there is no init, no network call, no global
// handler and no added cost on any path: `deno check`, `functions serve` and
// CI behave exactly as they did before this file existed. A DSN that turns out
// to be broken is swallowed for the same reason — error reporting must never
// become the error.
//
// NO GLOBAL SCOPE, EVER. The Deno SDK does not instrument Deno.serve, so there
// is no per-request scope separation, and edge isolates are reused across
// callers. A Sentry.setUser() here would be the same bug as caching a Db
// handle at module scope: one person's id riding along on the next person's
// error. So defaultIntegrations is off (nothing accumulates between requests)
// and every call passes its context directly instead.
//
// NO USER CONTENT. What goes up is the exception plus the operational tags the
// caller names — request id, rpc method, tool name, the user as an opaque id.
// Never tool arguments, set data or exercise names. The tags argument is the
// whole payload, so there is no second place a field can be attached from
// unseen.

type SentryApi = typeof import("@sentry/deno");

/** Resolved once per isolate: the initialised SDK, or null for "no DSN". */
let loaded: Promise<SentryApi | null> | null = null;

function sentry(): Promise<SentryApi | null> {
  if (loaded) return loaded;
  const dsn = Deno.env.get("SENTRY_DSN")?.trim();
  if (!dsn) {
    loaded = Promise.resolve(null);
    return loaded;
  }
  loaded = (async () => {
    try {
      const Sentry = await import("@sentry/deno");
      Sentry.init({ dsn, defaultIntegrations: false });
      return Sentry;
    } catch (e) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "sentry_init_failed",
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      return null;
    }
  })();
  return loaded;
}

/**
 * Send one exception, with operational tags and nothing else.
 *
 * Awaited by callers, and it flushes before returning: an edge isolate can be
 * frozen the moment its response is handed back, and a fire-and-forget capture
 * is how an event gets dropped exactly when it mattered. Callers are already
 * on a failure path, so the wait costs nothing anyone is waiting on.
 */
export async function captureError(
  err: unknown,
  tags: Record<string, string | undefined> = {},
): Promise<void> {
  try {
    const Sentry = await sentry();
    if (!Sentry) return;
    const clean: Record<string, string> = { function: "mcp-server" };
    for (const [k, v] of Object.entries(tags)) {
      if (v !== undefined) clean[k] = v;
    }
    Sentry.captureException(err, { tags: clean });
    await Sentry.flush(2000);
  } catch {
    // Never let error reporting throw into the path it is reporting on.
  }
}
