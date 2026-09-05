// Rest strip — docked above the session footer (in-flow, not floating).
// Counts down to the target, then keeps counting up in burnt ("OVER"):
// rest is recorded either way when the next set is logged.
// Notification API is used only if permission was already granted — never
// prompts. It is also not enough on its own: an installed iOS web app has no
// `new Notification(...)` constructor at all, so the tone from lib/restCue.ts
// is the announcement that actually reaches the lifter there. Both are
// attempted; both are silent when they cannot happen.

import { useEffect, useRef, useState } from "react";
import { formatClock } from "../lib/format";
import { playRestCue } from "../lib/restCue";
import { getRestSound } from "../lib/settings";

/** "2 min 30 sec" — "2:30" is read as a ratio or a date by most screen
 *  readers, and this string is the only way the remaining time is spoken. */
function spokenClock(totalSeconds: number): string {
  const t = Math.abs(Math.round(totalSeconds));
  const m = Math.floor(t / 60);
  const sec = t % 60;
  if (m === 0) return `${sec} sec`;
  return sec === 0 ? `${m} min` : `${m} min ${sec} sec`;
}

export interface ActiveRest {
  /** epoch ms when the rest started (i.e. when the set was logged) */
  startedAt: number;
  /** prescribed target, adjustable with -30/+30 or the pad */
  targetSeconds: number;
  /** "Barbell Row set 2" — what the rest will be recorded against */
  forLabel: string;
}

interface RestTimerProps {
  rest: ActiveRest | null;
  onAdjust: (deltaSeconds: number) => void;
  /** tap the clock: type the remaining seconds */
  onEdit: () => void;
  onDone: () => void;
}

export function RestTimer({ rest, onAdjust, onEdit, onDone }: RestTimerProps) {
  const [now, setNow] = useState(() => Date.now());

  // One rest is one `startedAt`. Keying the tick on the whole `rest` object
  // meant every −30/+30 built a new object by spread, which restarted the
  // interval — so the clock stuttered on every adjustment.
  const startedAt = rest?.startedAt ?? null;

  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, [startedAt]);

  const elapsed = rest ? Math.max(0, (now - rest.startedAt) / 1000) : 0;
  const remaining = rest ? rest.targetSeconds - elapsed : 0;
  const over = rest !== null && remaining < 0;

  // Notifying is a side effect, so it belongs in an effect. Raised from the
  // render body, React could fire a system notification for a render it went
  // on to discard — and a boolean ref set by that same render is no guard.
  //
  // What we remember is WHICH rest was announced, not merely that one was.
  // A boolean has to be cleared by somebody, and whoever clears it is a
  // second effect whose ordering you then have to reason about: with the
  // reset living in the tick effect above, a rest that was over the moment it
  // started (a zero-second target) never flipped `over` and so never got its
  // announcement. Keyed on the rest's own identity, ordering stops mattering.
  const announcedFor = useRef<number | null>(null);

  useEffect(() => {
    if (!over || startedAt === null) return;
    if (announcedFor.current === startedAt) return;
    // Marked announced BEFORE either cue is attempted, and for the rest as a
    // whole rather than per channel. Previously this line sat after the
    // notification guard, so on a browser that grants no permission the rest
    // was never recorded as announced — harmless while nothing else happened
    // here, and a tone on every 400 ms tick now that something does.
    announcedFor.current = startedAt;

    // The tone first: it is the only cue an installed iOS web app can make,
    // and it is the one the lifter hears with the phone face-down. The
    // preference is read here rather than subscribed to — see getRestSound.
    if (getRestSound()) playRestCue();

    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      // Desktop browsers only, in practice. iOS home-screen apps expose
      // `Notification` and will happily grant permission, then throw here
      // because only ServiceWorkerRegistration.showNotification is real —
      // which is why the catch is not decoration and why the tone above is
      // not a nicety.
      new Notification("Rest over", { body: "Next set." });
    } catch {
      // cosmetic
    }
  }, [over, startedAt]);

  if (!rest) return null;

  const pct = over
    ? 100
    : Math.round(
        Math.max(0, remaining / Math.max(1, rest.targetSeconds)) * 100,
      );

  return (
    /* role="timer" names the strip for a screen reader and carries an
       implicit aria-live="off": the value is reachable on demand, and a
       four-times-a-second countdown never interrupts anyone mid-set. */
    <div
      className={`rest-timer ${over ? "rest-timer-done" : ""}`}
      role="timer"
      aria-label="rest timer"
    >
      <div className="rest-row">
        <span className="rest-label">{over ? "OVER" : "REST"}</span>
        <button
          type="button"
          className="rest-timer-time"
          onClick={onEdit}
          /* the label ADDS to the visible time rather than replacing it —
             "edit remaining rest" alone left the clock unreadable */
          aria-label={`${
            over ? "over by" : "rest remaining"
          } ${spokenClock(remaining)} — tap to change`}
        >
          {over ? `+${formatClock(-remaining)}` : formatClock(remaining)}
        </button>
        <span className="rest-track">
          <span
            className="rest-fill"
            style={{ transform: `scaleX(${pct / 100})` }}
          />
        </span>
        <button
          type="button"
          className="rest-adjust"
          aria-label="take 30 seconds off the rest target"
          onClick={() => onAdjust(-30)}
        >
          −30
        </button>
        <button
          type="button"
          className="rest-adjust"
          aria-label="add 30 seconds to the rest target"
          onClick={() => onAdjust(30)}
        >
          +30
        </button>
        <button
          type="button"
          className="rest-timer-dismiss"
          aria-label="dismiss the rest strip — rest is still recorded"
          onClick={onDone}
        >
          DONE
        </button>
      </div>
      <div className="rest-foot">
        {over
          ? `Past the prescribed ${formatClock(rest.targetSeconds)} — still counting, still recorded.`
          : `Tap to change. Recorded against ${rest.forLabel}.`}
      </div>
    </div>
  );
}
