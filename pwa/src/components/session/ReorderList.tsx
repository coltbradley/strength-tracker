import { useEffect, useRef, useState, type ReactNode } from "react";
import { StateGlyph, type ProgressState } from "./StateGlyph";

/**
 * One draggable row. Whatever the row IS (an exercise, a whole superset) is
 * the caller's decision: it hands over one item per movable unit, so a list
 * built from `entryUnits()` can never offer to tear a superset apart.
 */
export interface ReorderItem {
  key: string;
  title: string;
  /** one line under the title, e.g. "3 × 8–10 · 60 kg" */
  subtitle?: string;
  /** right-aligned, e.g. "2/3" */
  meta?: string;
  state?: ProgressState;
  /** a small label shown above the row (a section name); presentation only */
  heading?: string;
}

export interface ReorderListProps {
  items: readonly ReorderItem[];
  /** Fired once per completed move, with indices into `items` as passed. The
   *  caller owns the order; this component only reports intent. */
  onMove(fromIndex: number, toIndex: number): void;
  /** Tap on the row body (not the handle). */
  onSelect?(key: string): void;
  /** Extra content under a row (e.g. an editor); optional. */
  renderExtra?(item: ReorderItem): ReactNode;
  /** Accessible name of the list. */
  label?: string;
  /** Key of the row to mark as selected. */
  selectedKey?: string | null;
}

interface Drag {
  from: number;
  to: number;
  startY: number;
  dy: number;
  pointerId: number;
}

/**
 * Today's-order list: a ⠿ handle per row, pointer drag on the handle,
 * ArrowUp/ArrowDown on the focused handle, tap on the body to select.
 *
 * The handle is a real button so the keyboard path exists and a screen reader
 * names it; `touch-action: none` on it (CSS) keeps a touch drag from
 * scrolling the page. Moves are announced through an aria-live region.
 */
export function ReorderList({
  items,
  onMove,
  onSelect,
  renderExtra,
  label = "Today's order",
  selectedKey = null,
}: ReorderListProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const handleRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const refocus = useRef<string | null>(null);

  // After a keyboard move the parent re-renders the row at its new index;
  // hand focus back to its handle so the next arrow press keeps going.
  useEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    handleRefs.current.get(key)?.focus();
  }, [items]);

  const announce = (item: ReorderItem, to: number) =>
    setAnnouncement(`${item.title} moved to position ${to + 1} of ${items.length}`);

  const targetIndex = (clientY: number): number => {
    let best = 0;
    items.forEach((item, i) => {
      const el = rowRefs.current.get(item.key);
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (clientY >= r.top + r.height / 2) best = i;
    });
    return best;
  };

  const finish = (commit: boolean) => {
    const d = drag;
    setDrag(null);
    if (d && commit && d.from !== d.to) {
      const item = items[d.from];
      onMove(d.from, d.to);
      if (item) announce(item, d.to);
    }
  };

  return (
    <div className="reorder">
      <ul className="reorder-list" aria-label={label}>
        {items.map((item, i) => {
          const dragging = drag?.from === i;
          const over = drag !== null && drag.to === i && drag.from !== i;
          return (
            <li
              key={item.key}
              ref={(el) => {
                if (el) rowRefs.current.set(item.key, el);
                else rowRefs.current.delete(item.key);
              }}
              className={`reorder-item${dragging ? " reorder-item-drag" : ""}${over ? " reorder-item-over" : ""}${selectedKey === item.key ? " reorder-item-selected" : ""}`}
              style={
                dragging ? { transform: `translateY(${drag.dy}px)` } : undefined
              }
            >
              {item.heading && (
                <div className="reorder-heading field-label">
                  {item.heading.toUpperCase()}
                </div>
              )}
              <div className="reorder-row">
                <button
                  type="button"
                  className="reorder-handle"
                  ref={(el) => {
                    if (el) handleRefs.current.set(item.key, el);
                    else handleRefs.current.delete(item.key);
                  }}
                  aria-label={`Reorder ${item.title}, position ${i + 1} of ${items.length}. Arrow keys move it.`}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    e.preventDefault();
                    const to = e.key === "ArrowUp" ? i - 1 : i + 1;
                    if (to < 0 || to >= items.length) return;
                    refocus.current = item.key;
                    onMove(i, to);
                    announce(item, to);
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== undefined && e.button > 0) return;
                    e.preventDefault();
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // capture is a nicety; the move handler still runs
                    }
                    setDrag({
                      from: i,
                      to: i,
                      startY: e.clientY,
                      dy: 0,
                      pointerId: e.pointerId,
                    });
                  }}
                  onPointerMove={(e) => {
                    if (!drag || drag.pointerId !== e.pointerId) return;
                    setDrag({
                      ...drag,
                      dy: e.clientY - drag.startY,
                      to: targetIndex(e.clientY),
                    });
                  }}
                  onPointerUp={(e) => {
                    if (!drag || drag.pointerId !== e.pointerId) return;
                    finish(true);
                  }}
                  onPointerCancel={() => finish(false)}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
                <button
                  type="button"
                  className="reorder-body"
                  aria-label={
                    item.state ? `${item.title} — ${item.state}` : item.title
                  }
                  onClick={() => onSelect?.(item.key)}
                >
                  {item.state && (
                    <StateGlyph
                      state={item.state}
                      label={`${item.title} — ${item.state}`}
                    />
                  )}
                  <span className="reorder-title">{item.title}</span>
                  {item.subtitle && (
                    <span className="reorder-sub">{item.subtitle}</span>
                  )}
                  {item.meta && (
                    <span className="reorder-meta">{item.meta}</span>
                  )}
                </button>
              </div>
              {renderExtra?.(item)}
            </li>
          );
        })}
      </ul>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
