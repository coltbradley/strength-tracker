// A `fetch` with a ceiling. Handed to the Supabase client so EVERY request
// the app makes carries one.
//
// The failure this exists for is a HANGING connection, not a failing one:
// gym wifi that associates but never routes, or a captive portal. `fetch`
// has no default timeout, so without this every read sits on "Loading…" for
// tens of seconds with the answer already in IndexedDB — which contradicts
// the whole offline-first design.

/**
 * Chosen to be well clear of a slow-but-working request rather than tight:
 * the largest read is the ~80 kB exercise library, so this only fires below
 * roughly 80 kbit/s of real throughput.
 *
 * An abort is safe on both sides. PostgREST turns a rejected fetch into a
 * normal error object with no code and status 0, so reads throw and fall
 * through to the IndexedDB cache, and the outbox classifies the same shape
 * as retryable rather than dead-lettering the write. Replay is idempotent
 * (client-generated UUIDs, on-conflict-do-nothing), so a write that actually
 * landed before the abort is not duplicated.
 */
export const REQUEST_TIMEOUT_MS = 8000;

export function createTimeoutFetch(
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  impl: typeof fetch = fetch,
): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(new DOMException("Request timed out", "AbortError")),
      timeoutMs,
    );
    // supabase-js passes its own signal on some calls; honour it as well as
    // the timeout rather than replacing it
    const upstream = init?.signal ?? null;
    const onUpstreamAbort = () => {
      controller.abort(upstream?.reason);
    };
    if (upstream) {
      if (upstream.aborted) onUpstreamAbort();
      else upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    }
    return impl(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", onUpstreamAbort);
    });
  };
}
