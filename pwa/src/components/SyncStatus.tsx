// Sync status: teal "N QUEUED" while pending, quiet "SYNCED" at rest, and a
// burnt "N FAILED" pill when permanently-failed writes are parked.
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
        className="sync-pill sync-dead"
        title={status.lastError ?? undefined}
        aria-label={`review ${status.dead} failed writes`}
        onClick={() => setQueueOpen(true)}
      >
        {status.dead} FAILED · REVIEW
      </button>
    ) : null;

  if (status.pending === 0 && status.state === "idle") {
    return (
      <span className="sync-group">
        {deadPill}
        {!deadPill && <span className="sync-pill sync-ok">SYNCED</span>}
        {sheet}
      </span>
    );
  }

  // Nothing pending is this device's to send: a flush would walk the queue and
  // hold every item, so the pill says what is true and opens the explanation.
  const allHeld = status.held === status.pending;

  const cls = allHeld
    ? "sync-held"
    : status.state === "error"
      ? "sync-err"
      : status.state === "syncing"
        ? "sync-busy"
        : "sync-pending";

  const label = allHeld
    ? `${status.held} HELD · REVIEW`
    : status.state === "syncing"
      ? `SYNCING ${status.pending}…`
      : status.state === "error"
        ? `${status.pending} STUCK · RETRY`
        : `${status.pending} QUEUED`;

  return (
    <span className="sync-group">
      {deadPill}
      <button
        type="button"
        className={`sync-pill ${cls}`}
        title={status.lastError ?? undefined}
        onClick={() => (allHeld ? setQueueOpen(true) : void outbox.flush())}
      >
        {label}
      </button>
      {sheet}
    </span>
  );
}
