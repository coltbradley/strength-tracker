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
import { readPersistedUserId } from "./persistedSession";

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
void supabase.auth.getSession().then(({ data, error }) => {
  // Same distinction useAuth makes: a null session with a RETRYABLE error is
  // "we could not ask", not "nobody". Reporting nobody here holds every
  // queued write — correct when identity is genuinely unknown, wrong when the
  // device knows perfectly well whose it is and only the network is down.
  set(
    data.session?.user?.id ??
      (error && isAuthRetryableFetchError(error)
        ? readPersistedUserId()
        : null),
  );
});
supabase.auth.onAuthStateChange((_event, session) => {
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
