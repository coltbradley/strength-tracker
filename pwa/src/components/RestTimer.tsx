// The rest clock, one component with two presentations of the same facts:
//
//  - "panel": the Focus screen's middle band — a big tappable clock with
//    −30/+30, then a REST OVER card once the target is reached.
//  - "strip": the compact bar List shows above its rows — the same clock, the
//    same adjustments, and a way to hide it.
//
// Counting down and announcing are two different jobs, and only the first
// belongs to a component that mounts and unmounts with sheets and with the
// Focus/List switch. The tone + notification are `useRestCue` (below), which
// Session mounts ONCE for the life of the screen, and which remembers which
// rest it already announced in module scope: a rest is announced once, not
// once per remount (H2). Rest is recorded either way when the next set is
// logged. Hiding the strip never ends the measured rest or advances the
// workout.
//
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
  /** whole seconds into the rest when the lifter pressed "End rest now".
   *  The target is NOT touched: "Ended early at 0:42 · target 2:30" needs
   *  both, and a target rewritten to the elapsed time read as "target 0:03". */
  endedEarlyAt?: number;
}

// ---- announce once per rest ------------------------------------------------

/** Rests whose end has already been announced, by `startedAt`. Module scope on
 *  purpose: a component's ref dies with every unmount (a sheet closing, the
 *  Focus/List switch), and the next mount saw an over rest it had never
 *  announced and played the tone again. Bounded, so a long session cannot
 *  grow it without end. */
const announcedRests: Array<{ startedAt: number; targetSeconds: number }> = [];

/** Has THIS rest, at this target, been announced? A later target (+30 after
 *  the rest was over) is a new deadline and is announced again; the same or a
 *  shorter one is not. */
export function restAnnounced(startedAt: number, targetSeconds = 0): boolean {
  return announcedRests.some(
    (r) => r.startedAt === startedAt && r.targetSeconds >= targetSeconds,
  );
}

/** A rest over by more than this when a screen first sees it is history, not
 *  news: a reload twenty minutes later must not say "Rest over". */
const STALE_REST_MS = 10_000;

function markAnnounced(startedAt: number, targetSeconds: number): void {
  const known = announcedRests.find((r) => r.startedAt === startedAt);
  if (known) known.targetSeconds = Math.max(known.targetSeconds, targetSeconds);
  else announcedRests.push({ startedAt, targetSeconds });
  if (announcedRests.length > 50) announcedRests.shift();
}

/** Mark a rest as announced without announcing it: a deliberate "End rest
 *  now" is the lifter's own act and must not be followed by a buzz for it. */
export function silenceRestCue(startedAt: number): void {
  markAnnounced(startedAt, Infinity);
}

/** Test seam: forget every announcement. */
export function resetRestCuesForTests(): void {
  announcedRests.length = 0;
}

/**
 * Fire the rest-over tone and notification exactly once per rest, at the
 * moment the target is reached — whatever is or is not on screen then.
 * Re-armed whenever the target moves (−30/+30, the pad), cleared when the rest
 * ends. Uses one timeout to the deadline rather than a ticking clock, so it
 * costs the screen that mounts it no re-renders.
 */
export function useRestCue(
  rest: ActiveRest | null,
  body: string | null,
): void {
  const startedAt = rest?.startedAt ?? null;
  const targetSeconds = rest?.targetSeconds ?? null;
  const bodyRef = useRef(body);
  bodyRef.current = body;

  useEffect(() => {
    if (startedAt === null || targetSeconds === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const announce = () => {
      if (restAnnounced(startedAt, targetSeconds)) return;
      // Marked announced BEFORE either cue is attempted, and for the rest as a
      // whole rather than per channel: a browser that grants no notification
      // permission must not be asked again on every re-arm.
      markAnnounced(startedAt, targetSeconds);
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
        new Notification("Rest over", {
          body: bodyRef.current ?? "Next set is ready.",
        });
      } catch {
        // cosmetic
      }
    };

    const arm = (cold = false) => {
      if (restAnnounced(startedAt, targetSeconds)) return;
      const remainingMs = startedAt + targetSeconds * 1000 - Date.now();
      if (remainingMs <= 0) {
        // Cold open on a rest that ended long ago: remember it, say nothing.
        if (cold && remainingMs < -STALE_REST_MS) {
          markAnnounced(startedAt, targetSeconds);
          return;
        }
        announce();
        return;
      }
      timer = setTimeout(arm, Math.min(remainingMs, 2_147_000_000));
    };
    arm(true);

    // A phone locked mid-rest suspends timers; on return the deadline has
    // passed and this is the moment to catch up.
    const onVisible = () => {
      if (document.visibilityState === "visible" && timer !== null) {
        clearTimeout(timer);
        timer = null;
        arm();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [startedAt, targetSeconds]);
}

// ---- the clock -------------------------------------------------------------

/**
 * The ticking clock of one rest: seconds elapsed, seconds remaining, and
 * whether it is over. Exported so the focus deck's "End rest now" link can
 * disappear the moment the rest is over without a second copy of the maths.
 */
export function useRestClock(rest: ActiveRest | null): {
  elapsed: number;
  remaining: number;
  ready: boolean;
} {
  const [now, setNow] = useState(() => Date.now());

  // One rest is one `startedAt`. Keying the tick on the whole `rest` object
  // meant every −30/+30 built a new object by spread, which restarted the
  // interval — so the clock stuttered on every adjustment.
  const startedAt = rest?.startedAt ?? null;

  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, [startedAt]);

  const elapsed = rest ? Math.max(0, (now - rest.startedAt) / 1000) : 0;
  const remaining = rest ? rest.targetSeconds - elapsed : 0;
  return {
    elapsed,
    remaining,
    ready:
      rest !== null && (rest.endedEarlyAt !== undefined || remaining <= 0),
  };
}

interface RestTimerProps {
  /** "panel" (Focus's middle band) or "strip" (List's compact bar) */
  variant?: "strip" | "panel";
  rest: ActiveRest | null;
  onAdjust: (deltaSeconds: number) => void;
  /** tap the clock: type the remaining seconds */
  onEdit: () => void;
  /** strip only: hide it (the clock keeps measuring) */
  onDone?: () => void;
  /** "Next: Barbell Row · set 3 of 4" — one line, computed by Session from
   *  the same logic the focus deck's own next-set label uses, so the two never
   *  name a different next set. Null when there is nothing left to look
   *  forward to. */
  nextSetLabel?: string | null;
}

export function RestTimer({
  variant = "panel",
  rest,
  onAdjust,
  onEdit,
  onDone,
  nextSetLabel = null,
}: RestTimerProps) {
  const { elapsed, remaining, ready } = useRestClock(rest);
  if (!rest) return null;

  const pct = ready
    ? 100
    : Math.round(
        Math.max(0, remaining / Math.max(1, rest.targetSeconds)) * 100,
      );

  const status = (
    <span className="sr-only" role="status" aria-live="assertive">
      {ready ? "Rest over. Your next set is ready when you are." : ""}
    </span>
  );

  if (variant === "panel") {
    return (
      <div
        key={rest.startedAt}
        className={`rest-panel ${ready ? "rest-panel-ready" : "rest-timer-enter"}`}
        role="timer"
        aria-label={ready ? "rest timer complete" : "rest timer"}
      >
        {status}
        {ready ? (
          <>
            <div className="rest-panel-label">■ REST OVER</div>
            <div className="rest-panel-ready-title">Ready when you are.</div>
            <div className="rest-panel-sub">
              {rest.endedEarlyAt !== undefined
                ? `Ended early at ${formatClock(rest.endedEarlyAt)} · target ${formatClock(rest.targetSeconds)}`
                : `${formatClock(elapsed)} since the last set · target ${formatClock(rest.targetSeconds)}`}
            </div>
            <button
              type="button"
              className="text-link rest-panel-retarget"
              onClick={onEdit}
              aria-label="rest over — tap to change the target"
            >
              Change target ›
            </button>
          </>
        ) : (
          <>
            <div className="rest-panel-head">
              <span className="rest-panel-label">◷ RESTING</span>
              <span className="rest-panel-adjust">
                <button
                  type="button"
                  className="rest-panel-btn"
                  aria-label="take 30 seconds off the rest target"
                  onClick={() => onAdjust(-30)}
                >
                  −30
                </button>
                <button
                  type="button"
                  className="rest-panel-btn"
                  aria-label="add 30 seconds to the rest target"
                  onClick={() => onAdjust(30)}
                >
                  +30
                </button>
              </span>
            </div>
            <button
              type="button"
              className="rest-panel-clock"
              onClick={onEdit}
              aria-label={`rest remaining ${spokenClock(remaining)} — tap to change`}
            >
              {formatClock(remaining)}
            </button>
            <span className="rest-panel-track">
              <span
                className="rest-panel-fill"
                style={{ transform: `scaleX(${pct / 100})` }}
              />
            </span>
          </>
        )}
        {nextSetLabel && (
          <div className="rest-panel-next" title={nextSetLabel}>
            {nextSetLabel}
          </div>
        )}
      </div>
    );
  }

  return (
    /* role="timer" names the strip for a screen reader and carries an
       implicit aria-live="off": the value is reachable on demand, and a
       four-times-a-second countdown never interrupts anyone mid-set. */
    <div
      key={rest.startedAt}
      className={`rest-timer ${ready ? "rest-timer-ready" : "rest-timer-rest rest-timer-enter"}`}
      role="timer"
      aria-label={ready ? "rest timer complete" : "rest timer"}
    >
      {status}
      <div className="rest-row">
        <span className="rest-label">{ready ? "■ REST OVER" : "◷ RESTING"}</span>
        <button
          type="button"
          className="rest-timer-time"
          onClick={onEdit}
          /* the label ADDS to the visible time rather than replacing it —
             "edit remaining rest" alone left the clock unreadable */
          aria-label={
            ready
              ? "rest over — tap to change the target"
              : `rest remaining ${spokenClock(remaining)} — tap to change`
          }
        >
          {ready ? "0:00" : formatClock(remaining)}
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
        {onDone && (
          <button
            type="button"
            className="rest-timer-dismiss"
            aria-label="hide the rest timer — rest is still recorded"
            onClick={onDone}
          >
            HIDE
          </button>
        )}
      </div>
      <div className="rest-foot">
        {nextSetLabel ??
          (ready
            ? "Next set when you are ready."
            : `Tap to change. Recorded against ${rest.forLabel}.`)}
      </div>
    </div>
  );
}

/**
 * The line above the dock's numbers while a rest runs: "NEXT SET · SET 4 OF
 * 6", so it is plain the numbers being edited belong to the NEXT set and not
 * the one just saved — and, until the rest is over, a quiet link to end it
 * early. Not a button-shaped button: starting early is allowed, never urged.
 */
export function RestDockTag({
  rest,
  label,
  onEndNow,
}: {
  rest: ActiveRest;
  label: string;
  onEndNow(elapsedSeconds: number): void;
}) {
  const { elapsed, ready } = useRestClock(rest);
  return (
    <div className="rest-dock-tag">
      <span className="rest-dock-tag-label">{label}</span>
      {!ready && (
        <button
          type="button"
          className="text-link"
          onClick={() => onEndNow(Math.floor(elapsed))}
        >
          End rest now ›
        </button>
      )}
    </div>
  );
}
