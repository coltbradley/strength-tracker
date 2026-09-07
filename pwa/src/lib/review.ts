// The turn after the session.
//
// A finished session has things in it nobody reads before the next one is
// written: a set note that says "could be more, maybe 70?", a percentage
// prescription that a training max could now be proposed from, an order the
// lifter changed. "Review with the coach" on Today's DONE card sends ONE turn
// naming the session, and the coach's system prompt says what a review is.
// This module decides which finished sessions get the offer, and writes the
// turn.

import { QueryError } from "./data";
import { formatPlannedDate, todayLocalIso } from "./format";
import { supabase } from "./supabase";

/** How long after a session ends the review is offered. A day: long enough
 *  to review over breakfast, short enough that the card is about THIS
 *  session and not last month's. */
export const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface EndedSession {
  id: string;
  planned_workout_id: string | null;
  ended_at: string;
}

/**
 * Finished, non-discarded sessions that ended inside the review window.
 * Server-filtered on `ended_at`, so the answer does not depend on how many
 * sessions this person has. Not cached: the offer is for something that
 * needs a connection anyway (the coach), and a stale "review this" on a
 * session from three days ago is worse than no button.
 */
export async function getRecentlyEndedSessions(
  now: number = Date.now(),
): Promise<EndedSession[]> {
  const since = new Date(now - REVIEW_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("sessions")
    .select("id, planned_workout_id, ended_at")
    .is("discarded_at", null)
    .not("ended_at", "is", null)
    .gte("ended_at", since)
    .order("ended_at", { ascending: false });
  if (error) {
    throw new QueryError(
      error.message,
      typeof error.code === "string" && error.code.length > 0
        ? error.code
        : null,
    );
  }
  return (data ?? []) as EndedSession[];
}

/**
 * planned_workout_id -> the most recent reviewable session against it.
 *
 * Pure, so the window rule is testable: a session outside the window is
 * dropped even if the server sent it (clock skew), a session with no planned
 * day has no card to sit on, and when a day was trained twice inside the
 * window the later session is the one offered.
 */
export function reviewableByDay(
  sessions: EndedSession[],
  now: number = Date.now(),
): Map<string, EndedSession> {
  const out = new Map<string, EndedSession>();
  for (const s of sessions) {
    if (s.planned_workout_id === null) continue;
    const endedAt = Date.parse(s.ended_at);
    if (Number.isNaN(endedAt)) continue;
    if (now - endedAt > REVIEW_WINDOW_MS || endedAt > now) continue;
    const prev = out.get(s.planned_workout_id);
    if (prev === undefined || s.ended_at > prev.ended_at) {
      out.set(s.planned_workout_id, s);
    }
  }
  return out;
}

/**
 * The first turn. Short and in the lifter's voice: the system prompt carries
 * the rubric (compare to prescribed, propose TMs, read the notes, fit the
 * phase, write nothing without a yes), so the turn only has to say WHICH
 * session. The id is what the coach needs to find it; the date is what the
 * lifter needs to recognise it.
 */
export function reviewPrompt(session: EndedSession): string {
  const day = formatPlannedDate(todayLocalIso(new Date(session.ended_at)));
  return `Review my session from ${day} with me. Session id: ${session.id}.`;
}
