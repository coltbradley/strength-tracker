// When a waiting service worker may take over the page (A-04).
//
// Applying an update reloads the page. Logged sets are safe, because they hit
// the IndexedDB outbox on the tap, but everything staged on the session
// screen (the load and reps in the steppers, a superset round's drafts, a
// half-typed note) lives in memory and does not survive a reload.
//
// The previous rule applied an update mid-session on the next hide. On a
// phone, the lock screen between sets IS a hide, so that rule reloaded
// workouts in the middle of a set. Now an open session is never interrupted:
// the update waits until no session is open, and is re-checked on every
// visibility change and on a timer so it still arrives promptly after Finish.
// If the app is closed outright, the browser activates the waiting worker on
// the next launch anyway, so nothing sits undelivered for long.

export interface UpdateGateDeps {
  /** true while an active session exists; must answer true when unsure */
  sessionInProgress: () => Promise<boolean>;
  /** reload into the waiting worker */
  apply: () => void;
  doc?: Pick<Document, "addEventListener" | "removeEventListener">;
  /** how often to re-check while waiting on a session */
  pollMs?: number;
}

export function createUpdateGate({
  sessionInProgress,
  apply,
  doc = document,
  pollMs = 60_000,
}: UpdateGateDeps): { onNeedRefresh: () => void } {
  let pending = false;
  let applied = false;
  let checking = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    doc.removeEventListener("visibilitychange", check);
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  async function check(): Promise<void> {
    if (!pending || applied || checking) return;
    checking = true;
    try {
      if (await sessionInProgress()) return;
      applied = true;
      stop();
      apply();
    } finally {
      checking = false;
    }
  }

  return {
    onNeedRefresh() {
      if (pending) {
        void check();
        return;
      }
      pending = true;
      doc.addEventListener("visibilitychange", check);
      timer = setInterval(() => void check(), pollMs);
      void check();
    },
  };
}
