// The decisions inside the alert sweep, pulled out of index.ts (which starts a
// server on import) so deno test can reach them.

export type DueAlert = {
  id: string;
  user_id: string;
  kind: string;
  label: string;
  fire_at: string;
};

export type SendOutcome = "sent" | "no_subscription" | "failed";

/**
 * The patch a send leaves on its row. Success MUST set sent_at: the sweep only
 * takes rows where it is null, so an empty patch re-sent the same prompt every
 * five minutes until the six hour stale cutoff (EDGE-1). A failure records the
 * reason and leaves sent_at null, so a transient failure retries until stale.
 */
export function sendStamp(
  ok: boolean,
  nowIso: string,
): { sent_at?: string; error?: string } {
  return ok ? { sent_at: nowIso } : { error: "every endpoint failed" };
}

/**
 * Walk the due rows. One row that throws (a bad subscription read, a stamp
 * that fails) is counted and logged, never allowed to abort the rest of the
 * batch (EDGE-12). A thrown row is left unstamped so it retries next sweep.
 */
export async function processDue(
  due: DueAlert[],
  nowMs: number,
  graceMs: number,
  deps: {
    stamp: (id: string, patch: { error: string }) => Promise<void>;
    send: (row: DueAlert) => Promise<SendOutcome>;
    onError: (row: DueAlert, e: unknown) => void;
  },
): Promise<{ sent: number; stale: number; failed: number }> {
  let sent = 0;
  let stale = 0;
  let failed = 0;
  for (const row of due) {
    try {
      if (nowMs - Date.parse(row.fire_at) > graceMs) {
        await deps.stamp(row.id, { error: "stale; not sent" });
        stale += 1;
        continue;
      }
      const outcome = await deps.send(row);
      if (outcome === "sent") sent += 1;
      else failed += 1;
    } catch (e) {
      failed += 1;
      deps.onError(row, e);
    }
  }
  return { sent, stale, failed };
}
