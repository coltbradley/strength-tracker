import { useEffect, useRef, useState, type ReactNode } from "react";
import { StateGlyph, type ProgressState } from "./StateGlyph";

/**
 * One movable unit. Whatever the unit IS (an exercise, a whole superset, a
 * named section's run) is the caller's decision: it hands over one item per
 * unit, so a list built from whole blocks can never offer to tear one apart.
 */
export interface ReorderLine {
  /** the exercise's own key: what a tap jumps to */
  key: string;
  title: string;
  /** one line under the title, e.g. "3×8-10 @ 60 KG" */
  subtitle?: string;
  state?: ProgressState;
  /** this exercise cannot be jumped to right now (a correction pins the
   *  screen to its own exercise): shown disabled, never silently inert */
  locked?: boolean;
}

export interface ReorderItem {
  key: string;
  /** one line per exercise in the unit: a lone exercise has one, a superset
   *  two, a named section its whole run. Each is its own tap target, so a
   *  block can never hide an exercise from "tap to jump". */
  lines: ReorderLine[];
  /** right-aligned, e.g. "2/3" */
  meta?: string;
  /** a quiet per-set receipt summary for the unit ("◐ on this phone") */
  receipt?: { glyph: string; label: string };
  /** a small label shown above the row (a section name); presentation only */
  heading?: string;
  /** whether a move one place up / down is allowed right now. The caller
   *  decides (it owns the order rules); the list never guesses. */
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

export interface ReorderListProps {
  items: readonly ReorderItem[];
  /**
   * Fired once per completed move: the unit at `fromIndex` should end at
   * `toIndex` of the same list. The caller owns the order and may refuse
   * (it returns false), in which case the list says so rather than going
   * quiet.
   */
  onMove(fromIndex: number, toIndex: number): boolean | void;
  /** Tap on an exercise line (not the handle), with that exercise's key. */
  onSelect?(entryKey: string): void;
  /** Extra content under a row; optional. */
  renderExtra?(item: ReorderItem): ReactNode;
  /** Accessible name of the list. */
  label?: string;
  /** Key of the row to mark as selected. */
  selectedKey?: string | null;
  /** True while a write is in flight: every control is shown, none moves. */
  disabled?: boolean;
}

interface Drag {
  from: number;
  to: number;
  startY: number;
  dy: number;
  pointerId: number;
  /** each OTHER row's midpoint, measured once at pointerdown */
  mids: number[];
}

/**
 * Today's-order list. Three ways to move a unit, all of which reach the same
 * `onMove`: drag the ⠿ handle (pointer), press ArrowUp/ArrowDown on the
 * focused handle (keyboard), or press the visible Move up / Move down
 * buttons (touch screen readers and anyone who cannot drag).
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
  disabled = false,
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

  const nameOf = (item: ReorderItem) =>
    item.lines.map((line) => line.title).join(" and ");

  const request = (item: ReorderItem, from: number, to: number) => {
    if (disabled) return;
    const moved = onMove(from, to);
    setAnnouncement(
      moved === false
        ? `${nameOf(item)} cannot move there: it would split a section or superset. Order unchanged.`
        : `${nameOf(item)} moved to position ${to + 1} of ${items.length}`,
    );
    return moved !== false;
  };

  const finish = (commit: boolean) => {
    const d = drag;
    setDrag(null);
    if (d && commit && d.from !== d.to) {
      const item = items[d.from];
      if (item) request(item, d.from, d.to);
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
              className={`reorder-item${dragging ? " reorder-item-drag" : ""}${over ? " reorder-item-over" : ""}${selectedKey !== null && item.lines.some((line) => line.key === selectedKey) ? " reorder-item-selected" : ""}`}
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
                  disabled={disabled}
                  ref={(el) => {
                    if (el) handleRefs.current.set(item.key, el);
                    else handleRefs.current.delete(item.key);
                  }}
                  aria-label={`Reorder ${nameOf(item)}, position ${i + 1} of ${items.length}. Arrow keys move it.`}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    e.preventDefault();
                    const to = e.key === "ArrowUp" ? i - 1 : i + 1;
                    if (to < 0 || to >= items.length) return;
                    refocus.current = item.key;
                    request(item, i, to);
                  }}
                  onPointerDown={(e) => {
                    if (disabled) return;
                    if (e.button !== undefined && e.button > 0) return;
                    e.preventDefault();
                    try {
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                    } catch {
                      // capture is a nicety; the move handler still runs
                    }
                    // Midpoints of every OTHER row, measured now. Measuring on
                    // every move included the dragged row, which carries its
                    // own translateY: a row grabbed in its lower half could
                    // then never be dragged up (M5).
                    const mids = items
                      .filter((_, index) => index !== i)
                      .map((other) => {
                        const el = rowRefs.current.get(other.key);
                        if (!el) return Number.POSITIVE_INFINITY;
                        const r = el.getBoundingClientRect();
                        return r.top + r.height / 2;
                      });
                    setDrag({
                      from: i,
                      to: i,
                      startY: e.clientY,
                      dy: 0,
                      pointerId: e.pointerId,
                      mids,
                    });
                  }}
                  onPointerMove={(e) => {
                    if (!drag || drag.pointerId !== e.pointerId) return;
                    const to = drag.mids.filter((mid) => mid < e.clientY).length;
                    setDrag({ ...drag, dy: e.clientY - drag.startY, to });
                  }}
                  onPointerUp={(e) => {
                    if (!drag || drag.pointerId !== e.pointerId) return;
                    finish(true);
                  }}
                  onPointerCancel={() => finish(false)}
                >
                  <span aria-hidden="true">⠿</span>
                </button>
                <span className="reorder-body">
                  {item.lines.map((line) => (
                    <button
                      key={line.key}
                      type="button"
                      className="reorder-line"
                      disabled={line.locked}
                      aria-label={
                        line.state ? `${line.title} — ${line.state}` : line.title
                      }
                      onClick={() => onSelect?.(line.key)}
                    >
                      <span className="reorder-title">
                        {line.state && (
                          <StateGlyph
                            state={line.state}
                            label={`${line.title} — ${line.state}`}
                          />
                        )}
                        {line.title}
                      </span>
                      {line.subtitle && (
                        <span className="reorder-sub">{line.subtitle}</span>
                      )}
                    </button>
                  ))}
                </span>
                <span className="reorder-count">
                  {item.meta && (
                    <span className="reorder-meta">{item.meta}</span>
                  )}
                  {item.receipt && (
                    <span
                      className="reorder-receipt"
                      role="img"
                      aria-label={item.receipt.label}
                      title={item.receipt.label}
                    >
                      {item.receipt.glyph}
                    </span>
                  )}
                </span>
                <span className="reorder-moves">
                  <button
                    type="button"
                    className="reorder-move"
                    aria-label={`Move ${nameOf(item)} up`}
                    disabled={disabled || item.canMoveUp === false || i === 0}
                    onClick={() => request(item, i, i - 1)}
                  >
                    <span aria-hidden="true">▲</span>
                  </button>
                  <button
                    type="button"
                    className="reorder-move"
                    aria-label={`Move ${nameOf(item)} down`}
                    disabled={
                      disabled || item.canMoveDown === false || i === items.length - 1
                    }
                    onClick={() => request(item, i, i + 1)}
                  >
                    <span aria-hidden="true">▼</span>
                  </button>
                </span>
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
