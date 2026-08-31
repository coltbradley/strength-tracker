// "Something's wrong" for someone who cannot read a stack trace.
//
// The app knows far more about a failure than the person holding it does, so
// the report carries the diagnostics automatically and asks the human for the
// one thing only they have: what they were trying to do. Everything below the
// textarea is collected, not typed.
//
// The button floats, which means it covers something. Rather than guess right
// for every screen, it MOVES: press and hold, drag, let go. It snaps to the
// nearer side edge and remembers where it was put (device-local, like every
// other setting here). Tap is still tap — a short press opens the report.
//
// Deliberately absent on /session and /end: those screens run their own footer
// and rest strip, and mid-set is the wrong moment to hand someone a second
// target to hit by accident.
import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet } from "./Sheet";
import { useOutboxStatus } from "../hooks/useOutboxStatus";
import { useSetting } from "../hooks/useSettings";
import { setSetting, type BugButtonPos } from "../lib/settings";
import { recentErrorLog, sendBugReport, toast } from "../lib/errors";
import { buildStamp } from "../lib/build";

/** Hold this long before the button comes loose. Below ~300ms a slow tap
 *  starts a drag; above ~600ms it feels broken. */
const LONG_PRESS_MS = 400;
/** Moving further than this before the hold completes means "scroll", not
 *  "drag" — the button lets go and the list moves under it. */
const MOVE_CANCEL_PX = 8;
/** Gap kept between the button and every screen edge. */
const MARGIN = 12;

function cssPx(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/** The rectangle the button is allowed to sit in: below the top bar, above
 *  the tab bar, inset by MARGIN on every side. */
function band(size: number) {
  const top = cssPx("--topbar-h") + MARGIN;
  const bottom = window.innerHeight - cssPx("--tabbar-h") - MARGIN - size;
  return { top, bottom: Math.max(top, bottom) };
}

function toPixels(pos: BugButtonPos, size: number) {
  const { top, bottom } = band(size);
  return {
    left: pos.side === "left" ? MARGIN : window.innerWidth - MARGIN - size,
    top: top + pos.y * (bottom - top),
  };
}

function fromPixels(left: number, top: number, size: number): BugButtonPos {
  const b = band(size);
  const span = b.bottom - b.top;
  return {
    // Snap to whichever edge the centre of the button is nearer. A button
    // parked mid-screen would cover a set list with no way to tell it is
    // movable; against an edge it reads as chrome.
    side: left + size / 2 < window.innerWidth / 2 ? "left" : "right",
    y: span <= 0 ? 0 : Math.min(1, Math.max(0, (top - b.top) / span)),
  };
}

interface ReportBugProps {
  userId: string | null;
  route: string;
}

export function ReportBug({ userId, route }: ReportBugProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const status = useOutboxStatus();

  const pos = useSetting("bugButtonPos");
  const btnRef = useRef<HTMLButtonElement>(null);
  // Pixel position while a drag is in flight; null the rest of the time, when
  // the stored side+fraction is the single source of truth.
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null);
  const [held, setHeld] = useState(false);

  const holdTimer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number; left: number; top: number }>({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
  });
  // Set when a drag actually happened, so the click that follows pointerup
  // opens nothing. Cleared on the next pointerdown.
  const moved = useRef(false);

  const clearHold = useCallback(() => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  // The stored position is a fraction of a band that changes size when the
  // phone rotates or the tab bar comes and goes. Re-rendering on resize is
  // enough — toPixels reads the live band every time.
  const [, forceResize] = useState(0);
  useEffect(() => {
    const onResize = () => forceResize((n) => n + 1);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  useEffect(() => clearHold, [clearHold]);

  const size = btnRef.current?.offsetWidth ?? 44;
  const at = drag ?? toPixels(pos, size);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    moved.current = false;
    const box = e.currentTarget.getBoundingClientRect();
    start.current = { x: e.clientX, y: e.clientY, left: box.left, top: box.top };
    clearHold();
    holdTimer.current = window.setTimeout(() => {
      setHeld(true);
      setDrag({ left: box.left, top: box.top });
      // Capture only once the hold has completed. Capturing on pointerdown
      // would swallow the scroll gesture that starts on top of the button.
      btnRef.current?.setPointerCapture(e.pointerId);
      // A short buzz is the only signal that the button is now loose; without
      // it a long press just looks like nothing happened. Absent on iOS, which
      // is why the button also grows.
      navigator.vibrate?.(15);
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    if (!held) {
      // Still deciding. A real move this early is a scroll, so give up the
      // press and let the page have the gesture.
      if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) clearHold();
      return;
    }
    moved.current = true;
    const b = band(size);
    setDrag({
      left: Math.min(
        window.innerWidth - MARGIN - size,
        Math.max(MARGIN, start.current.left + dx),
      ),
      top: Math.min(b.bottom, Math.max(b.top, start.current.top + dy)),
    });
  };

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    clearHold();
    if (!held) return;
    setHeld(false);
    if (btnRef.current?.hasPointerCapture(e.pointerId) === true) {
      btnRef.current.releasePointerCapture(e.pointerId);
    }
    if (drag !== null) setSetting("bugButtonPos", fromPixels(drag.left, drag.top, size));
    setDrag(null);
  };

  const submit = () => {
    setBusy(true);
    const sent = sendBugReport({
      message: text.trim(),
      diagnostics: {
        build: buildStamp(),
        route,
        user: userId ?? "signed out",
        online: navigator.onLine ? "yes" : "no",
        installed: window.matchMedia("(display-mode: standalone)").matches
          ? "yes"
          : "no",
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        // Queue depth is the single most useful number here: "my sets vanished"
        // and "my sets are sitting in the outbox" look identical from the couch.
        queued: status.pending,
        dead: status.dead,
        syncState: status.state,
        syncError: status.lastError,
        recentErrors: recentErrorLog(),
        userAgent: navigator.userAgent,
      },
    });
    setBusy(false);
    setOpen(false);
    setText("");
    // Never claim it was filed when no DSN is configured — that would be a
    // silent drop dressed up as a thank-you.
    toast(
      sent
        ? "Report sent. Thank you."
        : "Report not sent: no error reporting configured on this build.",
      sent ? "info" : "error",
    );
  };

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`bug-btn${held ? " bug-btn-held" : ""}`}
        style={{ left: `${at.left}px`, top: `${at.top}px` }}
        aria-label="report a problem (press and hold to move)"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          if (moved.current) return;
          setOpen(true);
        }}
        // Long-press on iOS otherwise raises the text-selection callout.
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* A bug, drawn rather than an emoji: emoji render differently on every
            platform and this one has to read at 20px on a cream card. */}
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          >
            <rect x="8" y="7.5" width="8" height="12" rx="4" />
            <path d="M8 11.5H4M8 15.5H4.5M8 19H5M16 11.5h4M16 15.5h3.5M16 19h3" />
            <path d="M9.5 7a2.5 2.5 0 0 1 5 0" />
          </g>
        </svg>
      </button>

      {open && (
        <Sheet title="Report a problem" onClose={() => setOpen(false)}>
          <div className="field-label">WHAT WENT WRONG?</div>
          <textarea
            className="input bug-text"
            data-sheet-autofocus
            rows={4}
            placeholder="What were you doing, and what happened instead?"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="microcopy">
            Your app version, screen, sync queue and the last few errors are
            attached automatically. No need to describe them.
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || text.trim().length < 3}
            onClick={submit}
          >
            {busy ? "Sending…" : "Send report"}
          </button>
          {/* The only place the button's movability is discoverable. Shown
              here because it is the one moment she is already looking at it. */}
          <div className="microcopy">
            In the way? Press and hold the bug button, then drag it anywhere.
          </div>
        </Sheet>
      )}
    </>
  );
}
