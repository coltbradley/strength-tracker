// Rest strip — docked above the session footer (in-flow, not floating).
// Counts down to the target, then keeps counting up in burnt ("OVER"):
// rest is recorded either way when the next set is logged.
// Notification API is used only if permission was already granted — never
// prompts.

import { useEffect, useRef, useState } from "react";
import { formatClock } from "../lib/format";

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
  const notified = useRef(false);

  useEffect(() => {
    if (!rest) return;
    notified.current = false;
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, [rest]);

  if (!rest) return null;

  const elapsed = Math.max(0, (now - rest.startedAt) / 1000);
  const remaining = rest.targetSeconds - elapsed;
  const over = remaining < 0;

  if (
    over &&
    !notified.current &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    notified.current = true;
    try {
      new Notification("Rest over", { body: "Next set." });
    } catch {
      // cosmetic
    }
  }

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
