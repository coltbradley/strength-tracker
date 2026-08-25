// App-level outbox singleton wired to the real Supabase client.

import { supabase } from "./supabase";
import { getDb } from "./db";
import { createOutbox, type OutboxTransport } from "./outbox";

const transport: OutboxTransport = {
  async insert(table, payload) {
    const { error } = await supabase
      .from(table)
      .upsert(payload as Record<string, unknown>, {
        onConflict: "id",
        ignoreDuplicates: true,
      });
    return error ? error.message : null;
  },
  async update(table, id, patch) {
    const { error } = await supabase
      .from(table)
      .update(patch as Record<string, unknown>)
      .eq("id", id);
    return error ? error.message : null;
  },
};

export const outbox = createOutbox({ getDb, transport });
