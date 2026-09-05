// App-level outbox singleton wired to the real Supabase client. The transport
// surfaces the PostgREST error code and HTTP status so the outbox can
// classify failures (retry vs dead-letter vs fix-and-retry).

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { getDb } from "./db";
import { getCurrentUserId, onUserChange } from "./currentUser";
import {
  createOutbox,
  type OutboxTransport,
  type TransportError,
} from "./outbox";

function toTransportError(
  error: { message: string; code?: string } | null,
  status: number | null,
): TransportError | null {
  if (!error) return null;
  return {
    message: error.message,
    code: error.code && error.code.length > 0 ? error.code : null,
    status,
  };
}

const transport: OutboxTransport = {
  async insert(table, payload) {
    const keyed = table === "set_voids" || table === "set_notes";
    const { error, status } = await supabase
      .from(table)
      .upsert(payload as Record<string, unknown>, {
        onConflict: keyed ? "set_id" : "id",
        // note edits overwrite; everything else is insert-if-absent
        ignoreDuplicates: table !== "set_notes",
      });
    return toTransportError(error, status ?? null);
  },
  async update(table, id, patch) {
    const { error, status } = await supabase
      .from(table)
      .update(patch as Record<string, unknown>)
      .eq("id", id);
    return toTransportError(error, status ?? null);
  },
  async refreshAuth() {
    // getSession() refreshes an expired token when a refresh token exists.
    //
    // The distinction the outbox depends on: returning FALSE means the server
    // answered and there is no valid session, so the item is dead. THROWING
    // means we never found out. getSession() does not throw on a network
    // failure — it returns `session: null` with a retryable error, which is
    // the same shape as a real sign-out — so without this test the outbox's
    // "unreachable, keep it pending" branch could never fire and a timeout on
    // gym wifi dead-lettered a whole session's worth of sets.
    const { data, error } = await supabase.auth.getSession();
    if (data.session !== null) return true;
    if (error && isAuthRetryableFetchError(error)) throw error;
    return false;
  },
};

export const outbox = createOutbox({
  getDb,
  transport,
  // Queued writes leave `user_id` to the database default (auth.uid()), so
  // without this a set queued by one user and flushed after a different user
  // signed in would be stamped with the wrong owner — permanently, because
  // `sets` is append-only. Stamping the OWNER on the item lets the flusher
  // hold it for the person it belongs to instead.
  currentUserId: getCurrentUserId,
  // Identity resolves asynchronously, and the flusher holds every stamped
  // item until it does. This is what un-holds them.
  onIdentityChange: onUserChange,
});
