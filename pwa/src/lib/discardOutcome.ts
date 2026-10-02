// What became of a queued session discard.
//
// `outbox.enqueue` resolving means the write is SAFE ON THIS PHONE, not that
// the server accepted it. A discard of a session that has sets is refused by
// the database (23514), the outbox marks it dead, and the screen that had
// already toasted "Session discarded" was telling the lifter something false
// about their record (UI-18). After the flush, the queue itself says which of
// three things happened.

export type DiscardOutcome =
  /** gone from the queue: the server took it */
  | "applied"
  /** still waiting (offline, or another account's): will apply later */
  | "queued"
  /** the server refused it; it is dead in the queue and the session stands */
  | "refused";

interface QueueLike {
  op: { kind: string; table: string; id?: string; patch?: unknown };
  state: "waiting" | "held" | "dead";
}

export function discardOutcome(
  entries: readonly QueueLike[],
  sessionId: string,
): DiscardOutcome {
  const mine = entries.filter((e) => {
    if (e.op.kind !== "update" || e.op.table !== "sessions") return false;
    if (e.op.id !== sessionId) return false;
    const patch = e.op.patch as { discarded_at?: unknown } | undefined;
    return patch !== undefined && "discarded_at" in patch;
  });
  if (mine.length === 0) return "applied";
  if (mine.some((e) => e.state === "dead")) return "refused";
  return "queued";
}
