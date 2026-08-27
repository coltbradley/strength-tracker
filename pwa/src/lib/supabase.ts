import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createTimeoutFetch } from "./timeoutFetch";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// DEV-ONLY demo mode (`npm run demo`): swap in the in-memory fake from
// src/dev/ so the whole app can be driven with no Supabase and no Docker.
// The dynamic import lives behind a build-time constant, so the mock and its
// fixtures are dead-code-eliminated from the production bundle.
const demoMode = import.meta.env.VITE_DEMO === "1";

export const supabaseConfigured = demoMode || Boolean(url && anonKey);

// A placeholder client keeps the module import-safe when env vars are missing
// (dev convenience); the Login screen surfaces the misconfiguration.
export const supabase: SupabaseClient = demoMode
  ? ((await (
      await import("../dev/mockSupabase")
    ).createMockSupabase()) as unknown as SupabaseClient)
  : createClient(
      url ?? "https://placeholder.supabase.co",
      anonKey ?? "placeholder-anon-key",
      // every request carries a timeout, so a hanging network falls back to
      // the IndexedDB cache promptly instead of blocking a screen — see
      // lib/timeoutFetch.ts
      { global: { fetch: createTimeoutFetch() } },
    );
