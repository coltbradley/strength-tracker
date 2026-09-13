// Tells the coach function to read this caller's own unprocessed check-in
// notes for standing facts, out of band from any conversation. Fire-and-
// forget by design: a check-in has already saved successfully by the time
// this runs (see sync.ts's outbox onSynced hook), and nothing here may turn
// into a toast or a thrown error that makes the save look like it failed.
import { supabase } from "./supabase";
import { reportError } from "./errors";

function endpoint(): string {
  const base = import.meta.env.VITE_SUPABASE_URL ?? "";
  return `${base}/functions/v1/coach/checkin-memory`;
}

async function bearer(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Ask, and forget. Never awaited by a caller in a way that could block or
 * fail a check-in save — call it and move on, exactly like `scheduleRestAlert`
 * on the LOG path.
 */
export function notifyCheckinMemory(): void {
  void run();
}

async function run(): Promise<void> {
  try {
    const token = await bearer();
    if (!token) return; // signed out; nothing to ask about
    const res = await fetch(endpoint(), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    // A non-2xx here is the route's own gates (quota, coach switched off,
    // not configured) or a transient failure the server already sent to
    // Sentry. Nothing for the lifter to do about it and nothing more for
    // this module to report.
    void res;
  } catch (e) {
    reportError(e, "checkin memory extraction", { toast: false });
  }
}
