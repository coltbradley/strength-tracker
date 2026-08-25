// Sync status: pending/syncing/error pill (tap = retry flush) plus a
// dead-letter pill when permanently-failed writes are parked — tapping it
// re-queues them ("retry failed").

import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { outbox } from "../lib/sync";

export function SyncStatus() {
  const status = useOutboxStatus();

  const deadPill =
    status.dead > 0 ? (
      <button
        type="button"
        className="sync-pill sync-err"
        title={status.lastError ?? undefined}
        onClick={() => void outbox.retryDead()}
      >
        {status.dead} failed · retry
      </button>
    ) : null;

  if (status.pending === 0 && status.state === "idle") {
    return (
      <span className="sync-group">
        {deadPill}
        {!deadPill && <span className="sync-pill sync-ok">synced</span>}
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
      ? `syncing ${status.pending}…`
      : status.state === "error"
        ? `${status.pending} stuck · retry`
        : `${status.pending} pending`;

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
