// Sync status: teal "N QUEUED" while pending, quiet "SYNCED" at rest, and a
// burnt "N FAILED · RETRY" pill when permanently-failed writes are parked —
// tapping that one re-queues them.

import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { outbox } from "../lib/sync";

export function SyncStatus() {
  const status = useOutboxStatus();

  const deadPill =
    status.dead > 0 ? (
      <button
        type="button"
        className="sync-pill sync-dead"
        title={status.lastError ?? undefined}
        onClick={() => void outbox.retryDead()}
      >
        {status.dead} FAILED · RETRY
      </button>
    ) : null;

  if (status.pending === 0 && status.state === "idle") {
    return (
      <span className="sync-group">
        {deadPill}
        {!deadPill && <span className="sync-pill sync-ok">SYNCED</span>}
      </span>
    );
  }

  const cls =
    status.state === "error"
      ? "sync-err"
      : status.state === "syncing"
        ? "sync-busy"
        : "sync-pending";

  const label =
    status.state === "syncing"
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
        onClick={() => void outbox.flush()}
      >
        {label}
      </button>
    </span>
  );
}
