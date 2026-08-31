// Long-press a row, drag it, drop it somewhere else.
//
// The plan editor already had ↑/↓ buttons, which work and stay — they are the
// keyboard and screen-reader path, and moving one exercise past six others is
// six taps. Dragging is for the reorder you can see.
//
// Same gesture contract as the floating dock (hooks/useFabDrag.ts), for the
// same reason: a list row must not swallow a scroll. The press must survive a
// stationary finger and give way the moment it moves, so the hold is cancelled
// by movement before it completes and pointer capture is taken only after.
import { useCallback, useEffect, useRef, useState } from "react";

const LONG_PRESS_MS = 350;
const MOVE_CANCEL_PX = 8;

export interface DragList {
  /** id being dragged, or null */
  dragging: string | null;
  /** where it would land if dropped now */
  overIndex: number | null;
  /** the order to render right now — the dragged row already moved */
  order: string[];
  handlers: (id: string, index: number) => {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
    onContextMenu: (e: React.SyntheticEvent) => void;
  };
}

/**
 * @param ids     current order
 * @param onDrop  called with the new order, only when it actually changed
 */
export function useDragList(
  ids: string[],
  onDrop: (nextIds: string[]) => void,
): DragList {
  const [dragging, setDragging] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>(ids);
  const holdTimer = useRef<number | null>(null);
  const startY = useRef(0);
  const rowH = useRef(0);
  const fromIndex = useRef(0);
  /** The element holding pointer capture, so it can actually be released. */
  const captured = useRef<{ el: HTMLElement; pointerId: number } | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // While not dragging, follow the source of truth. During a drag the local
  // order IS the truth, or every pointer move would be undone by a re-render.
  useEffect(() => {
    if (dragging === null) setOrder(ids);
  }, [ids, dragging]);

  const clearHold = useCallback(() => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  }, []);
  useEffect(() => clearHold, [clearHold]);

  const finish = (commit: boolean) => {
    clearHold();
    // Release FIRST, and unconditionally. A capture that outlives the drag
    // sends every later pointer event to this row, which is indistinguishable
    // from the page having frozen.
    const cap = captured.current;
    captured.current = null;
    if (cap !== null) {
      try {
        cap.el.releasePointerCapture(cap.pointerId);
      } catch {
        // already released, or the row unmounted under us
      }
    }
    if (dragging === null) return;
    const next = order;
    setDragging(null);
    setOverIndex(null);
    // Compare against the order this drag STARTED from, so dropping a row
    // back where it came from writes nothing.
    if (commit && next.join() !== ids.join()) onDrop(next);
    else setOrder(ids);
  };

  return {
    dragging,
    overIndex,
    order,
    handlers: (id, index) => ({
      onPointerDown: (e) => {
        // Hold the element in a variable. React sets e.currentTarget to NULL
        // once the handler returns, so reading it inside the timeout threw —
        // which happened after setDragging and before the capture, leaving the
        // row stuck mid-drag with no pointer capture and the page unable to
        // navigate away from it.
        const el = e.currentTarget as HTMLElement;
        const pointerId = e.pointerId;
        const box = el.getBoundingClientRect();
        startY.current = e.clientY;
        rowH.current = box.height || 1;
        fromIndex.current = index;
        captured.current = null;
        clearHold();
        holdTimer.current = window.setTimeout(() => {
          setDragging(id);
          setOverIndex(index);
          try {
            el.setPointerCapture(pointerId);
            captured.current = { el, pointerId };
          } catch {
            // Capture is an optimisation, not a requirement: without it the
            // drag still tracks while the finger stays over the list.
          }
          navigator.vibrate?.(15);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e) => {
        const dy = e.clientY - startY.current;
        if (dragging === null) {
          // Still deciding. Movement this early is a scroll: give it up.
          if (Math.abs(dy) > MOVE_CANCEL_PX) clearHold();
          return;
        }
        const moved = Math.round(dy / rowH.current);
        const to = Math.min(
          ids.length - 1,
          Math.max(0, fromIndex.current + moved),
        );
        setOverIndex(to);
        setOrder(() => {
          const next = ids.filter((x) => x !== id);
          next.splice(to, 0, id);
          return next;
        });
      },
      onPointerUp: () => finish(true),
      onPointerCancel: () => finish(false),
      onContextMenu: (e) => e.preventDefault(),
    }),
  };
}
