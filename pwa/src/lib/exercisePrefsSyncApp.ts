// App singleton for exercise-pref sync, wired to the real outbox, server read
// and identity. The rules live in lib/exercisePrefsSync.ts; this file only
// plugs them in, the same split as outbox.ts / sync.ts.

import { getCurrentUserId, onUserChange } from "./currentUser";
import { getExercisePrefRows, staleReason } from "./data";
import { reportError } from "./errors";
import { createExercisePrefsSync, pendingKey } from "./exercisePrefsSync";
import { outbox } from "./sync";

export const exercisePrefsSync = createExercisePrefsSync({
  fetchRows: getExercisePrefRows,
  enqueue: (ops) => outbox.enqueueBatch(ops),
  async pendingKeys() {
    const keys = new Set<string>();
    for (const e of await outbox.inspect()) {
      // Dead items count too: a write the server refused is not re-queued
      // under the same stamp on every reconcile (a new local choice has a new
      // stamp and is). Discardable refusals never reach here (see outbox).
      if (e.op.kind === "insert" && e.op.table === "exercise_prefs") {
        keys.add(pendingKey(e.op.payload.exercise_id, e.op.payload.updated_at));
      }
    }
    return keys;
  },
  // The LIVE identity only — not the session saved on disk. A preference is
  // not a set: nothing is lost by waiting for identity, because the stamp on
  // the device carries the write to the next reconcile.
  currentUserId: getCurrentUserId,
  onUserChange,
  report: (e, context) => {
    // No signal in the gym is not worth a toast; the next trigger retries.
    if (staleReason(e) === "offline") return;
    reportError(e, context);
  },
});
