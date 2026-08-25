// Rest countdown that auto-starts after logging a set. Large, dismissible.
// Uses the Notification API only if permission was already granted elsewhere —
// never prompts.

import { useEffect, useRef, useState } from "react";

interface RestTimerProps {
  /** epoch ms when the timer ends; null = no active timer */
  endsAt: number | null;
  onDismiss: () => void;
}

function fmt(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function RestTimer({ endsAt, onDismiss }: RestTimerProps) {
  const [now, setNow] = useState(() => Date.now());
  const notified = useRef(false);

  useEffect(() => {
    if (endsAt === null) return;
    notified.current = false;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [endsAt]);

  if (endsAt === null) return null;

  const remaining = Math.ceil((endsAt - now) / 1000);
  const done = remaining <= 0;

  if (
    done &&
    !notified.current &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    notified.current = true;
    try {
      new Notification("Rest over", { body: "Next set." });
    } catch {
      // notification failures are cosmetic
    }
  }

  return (
    <div className={`rest-timer ${done ? "rest-timer-done" : ""}`}>
      <div className="rest-timer-time">{done ? "GO" : fmt(remaining)}</div>
      <button type="button" className="rest-timer-dismiss" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  );
}
