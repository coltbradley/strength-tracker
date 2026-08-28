// App-level outbox singleton wired to the real Supabase client. The transport
// surfaces the PostgREST error code and HTTP status so the outbox can
// classify failures (retry vs dead-letter vs fix-and-retry).

import { supabase } from "./supabase";
import { getDb } from "./db";
import { getCurrentUserId } from "./currentUser";
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
    // getSession() refreshes an expired token when a refresh token exists
    const { data, error } = await supabase.auth.getSession();
    return !error && data.session !== null;
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
});
