// The session's controls live in the app TOPBAR, not in the screen: on the
// /session route the shell's "SET" wordmark gives way to "☰ 9/25" (opens
// Today's workout) and the Focus | List toggle. The topbar belongs to App and
// the controls' state belongs to Session, so App publishes a DOM slot through
// context and Session portals its controls into it — neither has to lift the
// other's state.
//
// The context distinguishes three cases on purpose:
//   undefined  no shell at all (a screen rendered in isolation, as in tests):
//              the caller renders the controls inline instead.
//   null       the shell exists but the slot has not mounted yet: render
//              nothing for a frame rather than flash them in the wrong place.
//   element    portal into it.

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const SessionHeaderSlotContext = createContext<
  HTMLElement | null | undefined
>(undefined);

export function useSessionHeaderSlot(): HTMLElement | null | undefined {
  return useContext(SessionHeaderSlotContext);
}

/** Render `children` into the topbar's session slot (see the cases above). */
export function SessionHeaderPortal({ children }: { children: ReactNode }) {
  const slot = useSessionHeaderSlot();
  if (slot === undefined) {
    return <div className="topbar-session topbar-session-inline">{children}</div>;
  }
  if (slot === null) return null;
  return createPortal(children, slot);
}

export type SessionPresentation = "focus" | "overview";

export interface SessionHeaderControlsProps {
  /** Completed non-voided sets across the plan. */
  done: number;
  /** Total target sets across the plan. */
  total: number;
  presentation: SessionPresentation;
  focusEligible: boolean;
  onOpenWorkout(): void;
  onFocus(): void;
  onList(): void;
}

export function SessionHeaderControls({
  done,
  total,
  presentation,
  focusEligible,
  onOpenWorkout,
  onFocus,
  onList,
}: SessionHeaderControlsProps) {
  return (
    <>
      <button
        type="button"
        className="session-hd-count"
        aria-label={`Today's workout, ${done} of ${total} sets done`}
        onClick={onOpenWorkout}
      >
        <span aria-hidden="true">☰</span>
        <span>
          {done}/{total}
        </span>
      </button>
      <div className="session-hd-toggle" role="group" aria-label="View">
        <button
          type="button"
          className="session-hd-seg"
          aria-pressed={presentation === "focus"}
          disabled={!focusEligible}
          onClick={onFocus}
        >
          Focus
        </button>
        <button
          type="button"
          className="session-hd-seg"
          aria-pressed={presentation === "overview"}
          onClick={onList}
        >
          List
        </button>
      </div>
    </>
  );
}
