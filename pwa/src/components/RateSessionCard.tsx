// Rating a session that is already over.
//
// sRPE is captured on the End screen, and End is only reached by tapping
// Finish. The overnight sweep that completes an abandoned session never goes
// there at all. So the number load management actually runs on is missing from
// exactly the sessions that were hardest to finish — which are the ones worth
// knowing about.
//
// This asks once, from Today, for a day afterwards. Past that the answer is a
// guess, and a guess in `session_rpe` is worse than the null it replaces:
// every read downstream treats that column as measured.

import { useCallback, useEffect, useState } from "react";
import {
  getUnratedSession,
  rateSession,
  type UnratedSessionRow,
} from "../lib/data";
import { cacheGet, cacheKeys, cacheSet } from "../lib/db";
import { outbox } from "../lib/sync";
import { reportError } from "../lib/errors";
import { SESSION_RPE_CHOICES } from "../lib/rpe";

/**
 * When the session was, in the words someone would use out loud.
 *
 * Deliberately coarse. The card exists because a workout went unrated, and
 * "yesterday evening" is enough to know which one — a timestamp would invite
 * the reader to check it against a memory they do not have.
 */
export function whenLabel(endedAt: string, now: number): string {
  const ended = new Date(endedAt).getTime();
  const hours = (now - ended) / 3_600_000;
  if (hours < 4) return "EARLIER TODAY";
  if (hours < 12) return "THIS MORNING";
  return "YESTERDAY";
}

export function RateSessionCard() {
  const [row, setRow] = useState<UnratedSessionRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await getUnratedSession();
        if (s === null || cancelled) return;
        // The server has not heard about a rating given in a basement gym.
        // Asking again for a number already given is the one thing this card
        // must never do, so a queued rating counts — dead ones too, because
        // the question has still been ANSWERED.
        const rated = await outbox.pendingRatedSessionIds();
        if (rated.has(s.id) || cancelled) return;
        // "Not now" is an answer as well, and it has to survive the remount
        // that happens every time this screen is navigated back to.
        const skipped = await cacheGet<boolean>(cacheKeys.rateSkipped(s.id));
        if (skipped === true || cancelled) return;
        setRow(s);
      } catch (e) {
        // A card that cannot load is a card that does not appear. Nothing else
        // on Today depends on this, so a failure here must not take the screen
        // down with it.
        reportError(e, "load unrated session");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rate = useCallback(
    (n: number) => {
      if (row === null) return;
      // Gone from the screen the moment it is tapped: the outbox owns the
      // write now, it replays on its own, and leaving the card up would read
      // as if the tap had not registered.
      setRow(null);
      void rateSession(row.id, n).catch((e: unknown) =>
        reportError(e, "rate session"),
      );
    },
    [row],
  );

  const skip = useCallback(() => {
    if (row === null) return;
    setRow(null);
    void cacheSet(cacheKeys.rateSkipped(row.id), true).catch((e: unknown) =>
      reportError(e, "skip session rating"),
    );
  }, [row]);

  if (row === null) return null;

  return (
    <section className="rule-section rate-card">
      <div className="section-head">
        <span className="field-label">
          RATE {whenLabel(row.ended_at, Date.now())}
        </span>
        <span className="section-meta">HOW HARD · OPTIONAL</span>
      </div>
      {/* The heading already says the session went unrated; repeating it here
          cost a line at the top of the screen, above START SESSION. What is
          left is the part nobody can infer — where the ends of the scale are. */}
      <div className="microcopy">0 is nothing, 10 is all you had.</div>
      {/* the End screen's grid and the End screen's scale, because it is the
          same column being written */}
      <div className="rpe-grid">
        {SESSION_RPE_CHOICES.map((n) => (
          <button
            key={n}
            type="button"
            className="seg-btn rpe-btn"
            aria-label={`session rpe ${n}`}
            onClick={() => rate(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-ghost" onClick={skip}>
        Not now
      </button>
    </section>
  );
}
