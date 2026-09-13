import type { ReactNode } from "react";
import { Sheet } from "../Sheet";

interface FocusMoreSheetProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

/**
 * Focus mode's one door to everything its default screen leaves out: RPE, a
 * set note, warmup/working, skip, the plate calculator, correcting or
 * voiding a logged set, last time, and the full logged-set history. Session
 * owns all of that state and every handler it calls, so this component is
 * only the sheet shell — the same one every other sheet in the app renders
 * through — around whatever content it is given.
 */
export function FocusMoreSheet({
  title,
  onClose,
  children,
}: FocusMoreSheetProps) {
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="focus-more">{children}</div>
    </Sheet>
  );
}
