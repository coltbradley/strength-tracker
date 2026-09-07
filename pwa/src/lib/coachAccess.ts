// Is the in-app coach switched on for this person? (coach_access, 20260907020000)
//
// This is a CONVENIENCE, not a boundary. The edge function enforces the switch
// and answers 403; all this does is stop the app offering a button that is
// going to say no. Which is why every uncertain answer here resolves to TRUE:
//
//   - no row            -> on. The default, and the reason the table could land
//                          on a running deployment without turning anyone off.
//   - read failed       -> on. "We could not ask" is not "no" (the same
//                          distinction persistedSession.ts draws for auth), and
//                          a dock that vanishes on a flaky connection is worse
//                          than a button that returns a clear 403.
//   - signed out        -> on. There is nobody to be switched off yet.
//
// Deliberately NOT cached through fetchWithCache. That cache exists so a stale
// plan beats a blank screen underground; an access decision that outlives its
// change is the opposite trade, and the row is one cheap read per app open.
import { supabase } from "./supabase";
import { reportError } from "./errors";

export interface CoachAccess {
  enabled: boolean;
  /** Shown to the person when off. Null means off with nothing to add. */
  reason: string | null;
}

export async function getCoachAccess(
  userId: string | null,
): Promise<CoachAccess> {
  if (!userId) return { enabled: true, reason: null };
  try {
    const { data, error } = await supabase
      .from("coach_access")
      .select("enabled, reason")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { enabled: true, reason: null };
    return {
      enabled: data.enabled as boolean,
      reason: (data.reason as string | null) ?? null,
    };
  } catch (e) {
    // Reported, never swallowed, and then treated as on.
    reportError(e, "getCoachAccess");
    return { enabled: true, reason: null };
  }
}
