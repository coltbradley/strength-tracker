// Sync status pill: n pending / syncing / error. Tapping retries the flush.

import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { outbox } from "../lib/sync";

export function SyncStatus() {
  const status = useOutboxStatus();

  if (status.pending === 0 && status.state === "idle") {
    return <span className="sync-pill sync-ok">synced</span>;
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
        ? `${status.pending} failed · retry`
        : `${status.pending} pending`;

  return (
    <button
      type="button"
      className={`sync-pill ${cls}`}
      title={status.lastError ?? undefined}
      onClick={() => void outbox.flush()}
    >
      {label}
    </button>
  );
}
