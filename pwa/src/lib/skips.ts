// Session-local skip bookkeeping. A skip is a fact about TODAY's workout —
// "the exercise" or "just its warmups" was skipped, and why — chosen by the
// lifter at log time (AGENTS.md: set type, exercise identity and skips are
// never decided by the prescription slot). Un-skipping mid-session never
// reaches the network; only what is STILL skipped at Finish is written, as
// session_skips (see screens/End.tsx and lib/sync.ts).

export interface SkipRecord {
  entryKey: string;
  prescriptionId: string | null;
  exerciseId: string;
  scope: "exercise" | "warmups";
  reason: string | null;
}

/**
 * `cacheKeys.sessionSkips` predates this: a session still open across the
 * deploy that shipped it has a plain array of skipped entry KEYS cached, with
 * no reason, no scope, and no exercise recorded. Both shapes read as the same
 * map so nothing downstream has to know which one it got. A legacy entry's
 * `exerciseId` is deliberately left "" here — Session never needs it for
 * display, and End.tsx resolves it from `rx`/`extras` at Finish, the one
 * place it is ever written to the server.
 */
export function readSkipsCache(
  raw: string[] | Record<string, SkipRecord> | null | undefined,
): Record<string, SkipRecord> {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out: Record<string, SkipRecord> = {};
    for (const entryKey of raw)
      out[entryKey] = {
        entryKey,
        prescriptionId: null,
        exerciseId: "",
        scope: "exercise",
        reason: null,
      };
    return out;
  }
  return raw;
}
