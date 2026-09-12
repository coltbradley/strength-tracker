/**
 * Write the audit row for a request refused by an already-enforced quota.
 *
 * Supabase returns PostgREST failures in `error` instead of throwing them. The
 * response must remain a 429 even if telemetry is unavailable, so the helper
 * reports either failure shape and never rethrows into the request handler.
 */
export async function recordRefusalUsage(
  write: () => PromiseLike<{ error: { message: string } | null }>,
  reportFailure: (message: string) => Promise<void>,
): Promise<void> {
  let failure: string | null = null;

  try {
    const { error } = await write();
    failure = error?.message ?? null;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  if (failure === null) return;

  try {
    await reportFailure(failure);
  } catch {
    // A failed alarm must not change an already-correct quota refusal.
  }
}
