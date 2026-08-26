// Rest strip — docked above the session footer (in-flow, not floating).
// Counts down to the target, then keeps counting up in burnt ("OVER"):
// rest is recorded either way when the next set is logged.
// Notification API is used only if permission was already granted — never
// prompts.

import { useEffect, useRef, useState } from "react";
import { formatClock } from "../lib/format";

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
    <div className={`rest-timer ${over ? "rest-timer-done" : ""}`}>
      <div className="rest-row">
        <span className="rest-label">{over ? "OVER" : "REST"}</span>
        <button
          type="button"
          className="rest-timer-time"
          onClick={onEdit}
          aria-label="edit remaining rest"
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
          onClick={() => onAdjust(-30)}
        >
          −30
        </button>
        <button
          type="button"
          className="rest-adjust"
          onClick={() => onAdjust(30)}
        >
          +30
        </button>
        <button type="button" className="rest-timer-dismiss" onClick={onDone}>
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
