// The calendar day, as a value that keeps up with the clock.
//
// An installed PWA is not a page load. iOS suspends it and resumes it hours or
// days later with the same JS heap, the same React tree and the same rendered
// output, so a `todayLocalIso()` read during render is a fact about whenever
// this screen last rendered — not about now. Left open on Monday evening and
// picked up on Tuesday morning, Today still said Monday, still offered
// MONDAY's "Start session", and the first tap filed the entire workout against
// Monday's planned day: `planned_workout_id` Monday's, every set's
// `prescription_id` pointing at Monday's brackets. `sets` is append-only, so
// nothing could take that back — Monday read DONE for ever and Tuesday stayed
// open for ever.
//
// Three things can tell us the day moved, and none of them is sufficient
// alone:
//
//   - a timer armed for the next local midnight, which is the only one that
//     fires while someone is actually looking at the screen;
//   - `visibilitychange`, because a backgrounded tab's timers are throttled
//     and a suspended app's do not run at all, so returning to the foreground
//     has to re-ask rather than trust a timer that may never have fired;
//   - `online`, because a phone that spent the night in a basement comes back
//     with connectivity before anyone touches it, and the server reads that
//     follow should be talking about the right day.
//
// The midnight boundary is computed from the current calendar date rather than
// by adding 24 hours, so a DST transition lands the timer on the real boundary
// instead of an hour either side of it.

import { useEffect, useState } from "react";
import { todayLocalIso } from "../lib/format";

/** A timer that fires exactly ON the boundary can still land a millisecond
 *  early once the browser has clamped it, read the old day, and re-arm itself
 *  for ~0 ms — a spin, not a rollover. A second past midnight is unambiguous
 *  and costs nothing anyone can perceive. */
const MIDNIGHT_CUSHION_MS = 1000;

/** Milliseconds from `now` until just after the next local midnight. */
function msUntilNextLocalMidnight(now: Date = new Date()): number {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(
    next.getTime() - now.getTime() + MIDNIGHT_CUSHION_MS,
    MIDNIGHT_CUSHION_MS,
  );
}

/** Today's local ISO date (`YYYY-MM-DD`), re-rendering when the day changes. */
export function useLocalToday(): string {
  const [today, setToday] = useState(() => todayLocalIso());

  useEffect(() => {
    let timer = 0;

    // Returning `prev` unchanged when the day has NOT moved is the whole
    // reason this is cheap to call often: React bails out of the re-render
    // entirely, so a wake-up, a reconnect, or a midnight already noticed by
    // one of the other three triggers costs nothing at all.
    const sync = () => {
      setToday((prev) => {
        const now = todayLocalIso();
        return now === prev ? prev : now;
      });
    };

    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        sync();
        // One night at a time. Re-arming from the clock we just woke up on
        // means the next boundary is recomputed rather than accumulated, so
        // drift and DST both come out in the wash.
        arm();
      }, msUntilNextLocalMidnight());
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      sync();
      // The timer armed before we were backgrounded may have been throttled
      // into uselessness or dropped entirely. Re-arming from a clock we have
      // just read is cheaper than working out whether to trust it.
      arm();
    };

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", sync);
    arm();

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", sync);
      window.clearTimeout(timer);
    };
  }, []);

  return today;
}
