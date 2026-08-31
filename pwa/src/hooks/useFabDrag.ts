// Long-press to pick up, drag, release to snap. Shared by everything that
// floats over the app.
//
// Extracted from the bug button when the coach arrived: two independently
// draggable things can be dragged on top of each other, which is worse than
// either being in the way. One dock holds both and moves as a unit.
//
// The gesture has one non-obvious requirement. Moving before the hold
// completes must CANCEL it, and pointer capture must be taken only after the
// hold, or a scroll flick that starts on the dock is swallowed and the list
// under it does not move — the exact thing that makes draggable buttons feel
// broken.
import { useCallback, useEffect, useRef, useState } from "react";
import { setSetting, type BugButtonPos } from "../lib/settings";

const LONG_PRESS_MS = 400;
const MOVE_CANCEL_PX = 8;
const MARGIN = 12;

function cssPx(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Where the dock may sit: below the top bar, above whatever bottom chrome this
 * route has, inset by MARGIN.
 *
 * The bottom is MEASURED here rather than read from a published variable. It
 * used to come from --tabbar-h, set by an effect on route change — which is
 * before the session footer has mounted, so the dock sat on top of it every
 * time. Reading the live element each time the dock positions itself has no
 * such ordering problem, and it costs one querySelector per render of a
 * two-button widget.
 */
function bottomChrome(): number {
  const el = document.querySelector(".tabbar, .session-footer");
  return el === null ? 0 : el.getBoundingClientRect().height;
}

function band(height: number) {
  const top = cssPx("--topbar-h") + MARGIN;
  const bottom = window.innerHeight - bottomChrome() - MARGIN - height;
  return { top, bottom: Math.max(top, bottom) };
}

export interface FabDrag {
  style: { left: string; top: string };
  held: boolean;
  handlers: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
    onContextMenu: (e: React.SyntheticEvent) => void;
  };
  /** true when the gesture just moved the dock, so the click that follows
   *  must not be treated as a tap on whatever is inside it */
  movedRef: React.MutableRefObject<boolean>;
  ref: React.RefObject<HTMLDivElement | null>;
}

export function useFabDrag(pos: BugButtonPos): FabDrag {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null);
  const [held, setHeld] = useState(false);
  const holdTimer = useRef<number | null>(null);
  const start = useRef({ x: 0, y: 0, left: 0, top: 0 });
  const movedRef = useRef(false);
  const [, bump] = useState(0);

  const clearHold = useCallback(() => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);

  // The stored position is a FRACTION of a band whose size changes with
  // rotation and with the bottom chrome coming and going, so any of that just
  // needs a re-render: the pixel position is derived fresh each time.
  //
  // The body observer is the load-bearing one. Bottom chrome does not appear
  // when the route changes, it appears when the screen under it finishes
  // loading — so a route-keyed effect measures too early and the dock sits on
  // top of the session footer. Watching the body catches it whenever it lands.
  useEffect(() => {
    const onResize = () => bump((n) => n + 1);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // Watching document.body does NOT work here: the app shell is a
    // viewport-height flex column, so the body's own box never changes when a
    // footer appears inside it. Watch the tree instead — that catches the
    // session footer mounting AND its height settling afterwards, which is the
    // gap that had the dock sitting 26px into it.
    let mo: MutationObserver | undefined;
    const root = document.getElementById("root");
    if (typeof MutationObserver !== "undefined" && root !== null) {
      let queued = false;
      mo = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          onResize();
        });
      });
      mo.observe(root, { childList: true, subtree: true });
    }
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      mo?.disconnect();
    };
  }, []);
  useEffect(() => clearHold, [clearHold]);

  const size = {
    w: ref.current?.offsetWidth ?? 44,
    h: ref.current?.offsetHeight ?? 44,
  };
  const b = band(size.h);
  const at = drag ?? {
    left: pos.side === "left" ? MARGIN : window.innerWidth - MARGIN - size.w,
    top: b.top + pos.y * (b.bottom - b.top),
  };

  const release = (e: React.PointerEvent<HTMLElement>) => {
    if (ref.current?.hasPointerCapture(e.pointerId) === true) {
      ref.current.releasePointerCapture(e.pointerId);
    }
  };

  return {
    style: { left: `${at.left}px`, top: `${at.top}px` },
    held,
    movedRef,
    ref,
    handlers: {
      onPointerDown: (e) => {
        movedRef.current = false;
        const box = e.currentTarget.getBoundingClientRect();
        start.current = {
          x: e.clientX,
          y: e.clientY,
          left: box.left,
          top: box.top,
        };
        clearHold();
        holdTimer.current = window.setTimeout(() => {
          setHeld(true);
          setDrag({ left: box.left, top: box.top });
          ref.current?.setPointerCapture(e.pointerId);
          navigator.vibrate?.(15);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e) => {
        const dx = e.clientX - start.current.x;
        const dy = e.clientY - start.current.y;
        if (!held) {
          if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) clearHold();
          return;
        }
        movedRef.current = true;
        setDrag({
          left: Math.min(
            window.innerWidth - MARGIN - size.w,
            Math.max(MARGIN, start.current.left + dx),
          ),
          top: Math.min(b.bottom, Math.max(b.top, start.current.top + dy)),
        });
      },
      onPointerUp: (e) => {
        clearHold();
        if (!held) return;
        setHeld(false);
        release(e);
        if (drag !== null) {
          const span = b.bottom - b.top;
          setSetting("bugButtonPos", {
            // Snap to whichever edge the dock's centre is nearer. Parked
            // mid-screen it covers a set list and reads as a bug.
            side:
              drag.left + size.w / 2 < window.innerWidth / 2 ? "left" : "right",
            y:
              span <= 0
                ? 0
                : Math.min(1, Math.max(0, (drag.top - b.top) / span)),
          });
        }
        setDrag(null);
      },
      onPointerCancel: (e) => {
        clearHold();
        if (!held) return;
        setHeld(false);
        release(e);
        setDrag(null);
      },
      // A long press otherwise raises the iOS selection callout.
      onContextMenu: (e) => e.preventDefault(),
    },
  };
}

/** Online state, for the things that genuinely cannot work without a network. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}
