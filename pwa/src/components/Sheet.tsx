// One bottom sheet, one dialog contract. Every sheet in the app renders
// through this — settings, plates, the number pad, and the exercise picker —
// so the accessibility behaviour is written once:
//
// - role="dialog" + aria-modal, named by a real <h2> via aria-labelledby.
//   `title` is required, so a caller cannot ship an unnamed dialog.
// - focus moves in on open (the sheet box itself, so the title is announced,
//   or an element marked data-sheet-autofocus), is trapped while open, and is
//   restored to whatever opened the sheet on close.
// - Escape closes. Backdrop click closes. The head CLOSE control closes.
// - Sheets nest (the number pad opens over Settings). Key handling lives on
//   the sheet element and stops there, so the innermost sheet wins.
// - The app root goes `inert` while any sheet is open, so a screen reader
//   cannot read through the scrim into the page behind it.
//
// Scroll ownership lives here: `.sheet` is overflow-y:auto with contained
// overscroll, so a sheet taller than its cap (Settings is ~2000px at 320px
// wide) scrolls to its last control with its head reachable at the top.
//
// Keyboard inset: neither iOS nor Android shrinks the LAYOUT viewport for a
// position:fixed overlay, so a bottom-anchored sheet sits behind the on-screen
// keyboard. `visualViewport` gives us the real inset; we publish it as --kb on
// the backdrop and the CSS lifts the sheet by exactly that much. Where the API
// is missing (older WebViews, jsdom) --kb stays 0 and nothing moves — the same
// behaviour the app had before.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
]
  .map((sel) => `${sel}:not([hidden])`)
  .join(",");

/** Nested sheets share one inert app root; the last one out turns it back on. */
let openSheets = 0;

function setRootInert(on: boolean) {
  const root = document.getElementById("root");
  if (!root) return;
  if (on) root.setAttribute("inert", "");
  else root.removeAttribute("inert");
}

/**
 * The on-screen keyboard's height in CSS pixels, or 0 when it is closed or
 * unmeasurable. Exported because the one keyboard-covered surface that is not
 * a sheet (the per-set note editor) needs the same number.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const next = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      // sub-pixel jitter while the keyboard animates would re-render on every
      // frame; only real movement counts
      setInset((prev) => (Math.abs(prev - next) < 1 ? prev : Math.round(next)));
    };
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    sync();
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);
  return inset;
}

/** matchMedia guard for the JS scroll APIs the CSS reduced-motion block
 *  cannot reach. Safe when matchMedia is absent (jsdom). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface SheetProps {
  /** The dialog's accessible name, rendered as its <h2>. Required. */
  title: string;
  onClose: () => void;
  /** Fixed-height variant: a sheet whose body is one long scrolling list. */
  tall?: boolean;
  /** Extra class on the sheet box, e.g. "pad-sheet". */
  className?: string;
  /**
   * Head-right slot. Omitted, it is the CLOSE control — the house dismissal.
   * Pass a node to replace it (the number pad puts its live value there and
   * carries CANCEL in its own action row).
   */
  headRight?: ReactNode;
  children: ReactNode;
}

export function Sheet({
  title,
  onClose,
  tall,
  className,
  headRight,
  children,
}: SheetProps) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const kb = useKeyboardInset();

  // Focus in on open, back to the opener on close. Captured before the first
  // paint so it is still the element the user tapped.
  useEffect(() => {
    openerRef.current = document.activeElement;
    openSheets += 1;
    setRootInert(true);

    const box = boxRef.current;
    const seed =
      box?.querySelector<HTMLElement>("[data-sheet-autofocus]") ?? box;
    seed?.focus({ preventScroll: true });

    return () => {
      openSheets = Math.max(0, openSheets - 1);
      if (openSheets === 0) setRootInert(false);
      // never focus into a still-inert subtree
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const box = boxRef.current;
    if (!box) return;
    // A nested sheet portals elsewhere, so this query only ever sees its own
    // controls; stopping here keeps the outer sheet's trap out of the way.
    e.stopPropagation();
    const items = [...box.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) {
      e.preventDefault();
      box.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="sheet-backdrop"
      style={{ "--kb": `${kb}px` } as CSSProperties}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={["sheet", tall ? "sheet-tall" : "", className ?? ""]
          .filter(Boolean)
          .join(" ")}
        onKeyDown={onKeyDown}
      >
        <div className="sheet-head">
          <h2 className="sheet-title" id={titleId}>
            {title}
          </h2>
          {headRight === undefined ? (
            <button type="button" className="sheet-close" onClick={onClose}>
              CLOSE
            </button>
          ) : (
            headRight
          )}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
