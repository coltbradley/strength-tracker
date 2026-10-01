// Healthy sync is intentionally quiet, but no longer absent: when everything is
// on the server the chip is a round 44px mark showing only a check, so the
// lifter can always see that nothing is waiting (and tap it to read the
// queue). Queued, active, and failed writes WIDEN the chip into glyph + label,
// because they still need the lifter's attention or judgment. Version D
// review items 12-13: the glyph carries the state, the label names it.
//
// The glyph is decorative (aria-hidden); the accessible name is the label plus
// what a tap does, so the visible words are always inside the name.
//
// The two pills that cannot be fixed by asking again OPEN the queue instead of
// pretending to act on it. A dead item needs a reason before it needs a retry,
// and a HELD item cannot move at all until its own account signs in here — a
// pill that flushed on tap was, for that state, a button that did nothing and
// said nothing about why. Everything else still taps to flush, which is
// exactly what it does.

import { useState } from "react";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { OutboxSheet } from "./OutboxSheet";
import { outbox } from "../lib/sync";

export function SyncStatus() {
  const status = useOutboxStatus();
  const [queueOpen, setQueueOpen] = useState(false);

  const sheet = queueOpen ? (
    <OutboxSheet onClose={() => setQueueOpen(false)} />
  ) : null;

  const deadPill =
    status.dead > 0 ? (
      <button
        type="button"
        className="sync-chip sync-chip-dead"
        title={status.lastError ?? undefined}
        aria-label={`Review ${status.dead} failed writes`}
        onClick={() => setQueueOpen(true)}
      >
        <span className="sync-chip-glyph" aria-hidden="true">
          !
        </span>
        <span>Review</span>
      </button>
    ) : null;

  if (status.pending === 0 && status.state === "idle") {
    if (!deadPill) {
      // Everything is on the server. A round check, tap opens the queue.
      return (
        <span className="sync-group">
          <button
            type="button"
            className="sync-chip sync-chip-ok"
            aria-label="All sets on the server"
            onClick={() => setQueueOpen(true)}
          >
            <span className="sync-chip-glyph" aria-hidden="true">
              ✓
            </span>
          </button>
          {sheet}
        </span>
      );
    }
    return (
      <span className="sync-group">
        {deadPill}
        {sheet}
      </span>
    );
  }

  // Nothing pending is this device's to send: a flush would walk the queue and
  // hold every item, so the chip says what is true and opens the explanation.
  const allHeld = status.held === status.pending;

  // `state === "error"` here means a RETRYABLE failure — a network blip,
  // a timed-out auth refresh — that stopped the flush without
  // dead-lettering anything (outbox.ts's classify()). Nothing is lost and
  // nothing needs a person's judgment yet, so it reads the same neutral
  // ink as an ordinary queued write ("On phone"). Filled --danger and
  // "Review" stay reserved for the failed chip above (`status.dead`), which
  // is an item the server refused on the merits of the row — the one case
  // that actually needs someone to look at it.
  const kind = allHeld
    ? "held"
    : status.state === "syncing"
      ? "busy"
      : "pending";

  const glyph = kind === "held" ? "‖" : kind === "busy" ? "↑" : "◐";
  const label =
    kind === "held"
      ? "Held"
      : kind === "busy"
        ? `Sending · ${status.pending}`
        : `On phone · ${status.pending}`;
  const action =
    kind === "held"
      ? "review the queue"
      : status.state === "error"
        ? "retrying, tap to retry"
        : kind === "pending"
          ? "tap to send"
          : "tap to send now";

  return (
    <span className="sync-group">
      {deadPill}
      <button
        type="button"
        className={`sync-chip sync-chip-${kind}`}
        title={status.lastError ?? undefined}
        aria-label={`${label}, ${action}`}
        onClick={() => (allHeld ? setQueueOpen(true) : void outbox.flush())}
      >
        <span className="sync-chip-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span>{label}</span>
      </button>
      {sheet}
    </span>
  );
}
