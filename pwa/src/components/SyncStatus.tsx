// Healthy sync is intentionally quiet, but no longer absent: when everything is
// on the server the chip is a round 44px mark showing only a check, so the
// lifter can always see that nothing is waiting (and tap it to read the
// queue). Queued, active, and failed writes WIDEN the chip into glyph + label,
// because they still need the lifter's attention or judgment. Version D
// review items 12-13: the glyph carries the state, the label names it.
//
// The chip never claims what it does not know. Until the queue has been read
// at least once (`useOutboxKnown`) it is a neutral round mark that says so,
// never a check: a phone reloaded in a basement with sets waiting would
// otherwise show a green ✓ while the count was still loading, and a failed
// read of an empty queue is not "Held". Words say "writes" not "sets": the
// queue also holds voids, notes and the session row itself.
//
// The glyph is decorative (aria-hidden); the accessible name is the label plus
// what a tap does, so the visible words are always inside the name.
//
// EVERY tap answers: it opens the queue sheet, in every state, including the
// quiet check ("everything is on the server") and while offline. A chip that
// flushed silently, or did nothing at all offline, was a button with no
// feedback. Waiting and sending chips also start a flush when the phone is
// online (it is what they used to do); a HELD item cannot move until its own
// account signs in and a dead one needs a reason before a retry, so those only
// open the sheet.
//
// The wide label is for the roomy header. In the one-row session header the
// chip must not grow (the whole screen used to jump under the thumb), so each
// chip also carries `data-count` and the stylesheet shows glyph + count in a
// fixed-width chip there; the words stay in the accessible name and the sheet.

import { useState } from "react";
import { useOutboxKnown, useOutboxStatus } from "../hooks/useOutboxStatus";
import { OutboxSheet } from "./OutboxSheet";
import { outbox } from "../lib/sync";
import { useOnline } from "../hooks/useFabDrag";

export function SyncStatus() {
  const status = useOutboxStatus();
  const known = useOutboxKnown();
  const online = useOnline();
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
        data-count={status.dead > 9 ? "9+" : status.dead}
        onClick={() => setQueueOpen(true)}
      >
        <span className="sync-chip-glyph" aria-hidden="true">
          !
        </span>
        <span>Review</span>
      </button>
    ) : null;

  // The queue has not been read yet: say nothing true is known. A round, quiet
  // mark that opens the queue — never the ✓ that means "nothing is waiting".
  if (!known && status.pending === 0 && status.dead === 0) {
    return (
      <span className="sync-group">
        <button
          type="button"
          className="sync-chip sync-chip-unknown"
          aria-label="Checking what is waiting to send, open the queue"
          onClick={() => setQueueOpen(true)}
        >
          <span className="sync-chip-glyph" aria-hidden="true">
            ◌
          </span>
        </button>
        {sheet}
      </span>
    );
  }

  if (status.pending === 0 && status.state === "idle") {
    if (!deadPill) {
      // Nothing is waiting. A round check, tap opens the queue.
      return (
        <span className="sync-group">
          <button
            type="button"
            className="sync-chip sync-chip-ok"
            aria-label={
              online
                ? "Nothing waiting to send"
                : "Nothing waiting to send, offline"
            }
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
  // An EMPTY queue is not "all held" (that is true of zero of zero): with
  // nothing pending and a status that is not idle, the chip is about the
  // status (an error refreshing it, a flush ending), not about held writes.
  const allHeld = status.pending > 0 && status.held === status.pending;

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

  const count = status.pending > 0 ? ` · ${status.pending}` : "";
  const glyph = kind === "held" ? "‖" : kind === "busy" ? "↑" : "◐";
  const label =
    kind === "held"
      ? "Held"
      : kind === "busy"
        ? `Sending${count}`
        : status.pending > 0
          ? `On phone${count}`
          : "Retrying";
  const action =
    kind === "held"
      ? "review the queue"
      : !online
        ? "offline, tap to see the queue"
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
        data-count={status.pending > 9 ? "9+" : status.pending || undefined}
        onClick={() => {
          setQueueOpen(true);
          if (!allHeld && online) void outbox.flush();
        }}
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
