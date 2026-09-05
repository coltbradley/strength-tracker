// Error tracking: Sentry when a DSN is configured, and nothing whatsoever when
// it is not. The twin of mcp-server/lib/sentry.ts — the two functions are
// separate Deno projects with separate import maps, so this is a copy rather
// than a shared module, and it is thirty lines rather than a framework.
//
// This sits ALONGSIDE the structured log lines, never instead of them. The
// logs are the complete story and cost nothing, but reading them means being
// signed into the Supabase dashboard with analytics working — which during the
// September audit it was not, so a failed turn was invisible until someone
// thought to ask. Logs are the record; this is the thing that reaches a person.
//
// INERT WITHOUT A DSN, and inert here means the SDK is never even loaded. The
// import is dynamic and is only reached once SENTRY_DSN is a non-empty string,
// so with the secret unset there is no init, no network call and no added cost
// on any path: `deno check`, `functions serve` and CI behave exactly as they
// did before this file existed.
//
// NO GLOBAL SCOPE, EVER. The Deno SDK does not instrument Deno.serve, so there
// is no per-request scope separation, and edge isolates are reused across
// callers — a Sentry.setUser() here would attach one lifter's id to the next
// lifter's error. defaultIntegrations is off so nothing accumulates between
// requests, and every call passes its context directly instead.
//
// NO CONVERSATION, EVER. coach_usage stores the prompt and the answer, and
// that is a deliberate product decision with a switch on it
// (COACH_LOG_CONTENT). Sentry is not covered by that decision and must never
// become a second, unswitchable copy: what goes up is the exception plus
// operational tags — user id, turn id, which stage failed. Never the prompt,
// the answer, an attachment or a filename. The tags argument is the whole
// payload, so nothing can be attached from somewhere unseen.

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
        JSON.stringify({ event: "sentry_init_failed", error: String(e) }),
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
 * frozen the moment its response is done, and a fire-and-forget capture is how
 * an event gets dropped exactly when it mattered. Every caller is already on a
 * failure path, and in the streaming case the person has been answered (or
 * told it failed) before this runs, so the wait costs nobody anything.
 */
export async function captureError(
  err: unknown,
  tags: Record<string, string | undefined> = {},
): Promise<void> {
  try {
    const Sentry = await sentry();
    if (!Sentry) return;
    const clean: Record<string, string> = { function: "coach" };
    for (const [k, v] of Object.entries(tags)) {
      if (v !== undefined) clean[k] = v;
    }
    Sentry.captureException(err, { tags: clean });
    await Sentry.flush(2000);
  } catch {
    // Never let error reporting throw into the path it is reporting on.
  }
}
