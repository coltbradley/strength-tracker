// The signed-in user id, readable SYNCHRONOUSLY.
//
// `supabase.auth.getSession()` is async, but two callers need the answer
// immediately and cannot await: the outbox stamps every queued write with its
// owner at enqueue time, and the cache-ownership check runs before a screen
// reads anything. So this module mirrors the auth state into a plain variable
// and keeps it current.
//
// It is a mirror, never the source of truth. Anything making an authorization
// decision must use the session itself; this only answers "whose data is this
// device holding right now", which is a local bookkeeping question.

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { resolveBootSession } from "./persistedSession";

let userId: string | null = null;
const listeners = new Set<(id: string | null) => void>();

function set(next: string | null): void {
  if (next === userId) return;
  userId = next;
  for (const fn of listeners) fn(next);
}

// Self-initialising on import: main.tsx starts the outbox during module
// evaluation, so waiting for a component to mount would leave the first
// queued write unstamped.
//
// Same distinction useAuth makes: a null session with a RETRYABLE error is
// "we could not ask", not "nobody". Reporting nobody here holds every
// queued write — correct when identity is genuinely unknown, wrong when the
// device knows perfectly well whose it is and only the network is down. And
// the stored identity is used after a short wait rather than after the ~25 s
// a dead-network refresh takes, because a set logged in that window would be
// stamped null and HELD (NEW-CORE-1). The real answer, when it arrives, wins.
resolveBootSession(
  () => supabase.auth.getSession(),
  isAuthRetryableFetchError,
  (session) => set(session?.user?.id ?? null),
  // errors.ts imports the outbox, which imports this module: load it lazily
  // so the cycle never exists at evaluation time.
  (e) =>
    void import("./errors").then((m) => m.reportError(e, "read the signed-in user")),
);
supabase.auth.onAuthStateChange((event, session) => {
  // INITIAL_SESSION(null) also means "auth-js's own getSession errored", which
  // the boot answer above handles knowing the difference (CORE-1). A real
  // sign-out arrives as SIGNED_OUT.
  if (event === "INITIAL_SESSION" && session === null) return;
  set(session?.user?.id ?? null);
});

/** The signed-in user id, or null. Null also means "not known yet". */
export function getCurrentUserId(): string | null {
  return userId;
}

/** Notified whenever the signed-in user changes, including to null. */
export function onUserChange(fn: (id: string | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
