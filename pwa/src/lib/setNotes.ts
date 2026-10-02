// Merging a freshly fetched set-note map into what the screen already holds.
//
// set_notes is last-write-wins and the SERVER row is the acknowledged truth.
// The device cache holds acknowledged notes too, and an older copy of one must
// never beat a newer server note (UI-21): only a note this device still OWES
// the server (queued, dead or typed this visit) keeps its local text.

import type { OutboxEntry } from "./outbox";

/** Set ids with a set_notes write still in the queue, dead ones included: the
 *  lifter typed it and the server has not heard it. */
export function pendingNoteSetIds(
  entries: readonly OutboxEntry[],
): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    if (e.op.kind === "insert" && e.op.table === "set_notes") {
      ids.add(e.op.payload.set_id);
    }
  }
  return ids;
}

/**
 * `owed` = set ids whose local note is unsent. Everything else takes the
 * server's text. A local note the server does not list at all is kept: it may
 * be in flight, and a note is never deleted by a read that merely lacks it.
 */
export function mergeSetNotes(
  fresh: Record<string, string>,
  prev: Record<string, string>,
  owed: ReadonlySet<string>,
): Record<string, string> {
  const next: Record<string, string> = { ...fresh };
  for (const [id, note] of Object.entries(prev)) {
    if (owed.has(id) || !(id in fresh)) next[id] = note;
  }
  return next;
}
