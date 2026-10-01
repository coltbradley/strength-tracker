// The RPE key's own sheet: the question first, then the chips, then the sets
// already logged for this exercise (with their receipts, Fix and void). It
// answers one thing — "how hard was it?" — and says WHICH set that rates:
//
//  - while a rest runs, the set you just saved. A rating is a correction like
//    any other (`sets` is append-only), so tapping a chip writes a replacement
//    row at the same place and the title says "set 3, just saved";
//  - otherwise, the set about to be logged, which is only a staged value.
//
// Saying so in the title is the point (M1): during a rest the panel above the
// dock reads LAST SET, and a sheet that quietly rated the NEXT set put set N's
// rating on set N+1.

import type { ReactNode } from "react";
import { Sheet } from "../Sheet";
import { RPE_CHOICES } from "../../lib/rpe";

export function RpeSheet({
  title,
  question,
  value,
  onChange,
  loggedHeading,
  loggedRows,
  onMore,
  onClose,
}: {
  /** "Rate set 3 (just saved)" or "RPE for the next set" */
  title: string;
  /** "How hard was it? Optional; blank is fine." */
  question: string;
  value: number | null;
  /** null when the selected chip is tapped again */
  onChange(rpe: number | null): void;
  /** "Logged for Bench Press" */
  loggedHeading: string;
  loggedRows: ReactNode;
  /** the rest of what the exercise offers (warmup, how-to, plates, notes) */
  onMore?(): void;
  onClose(): void;
}) {
  return (
    <Sheet title={title} onClose={onClose} className="rpe-sheet">
      <p className="rpe-sheet-question">{question}</p>
      <div className="rpe-grid rpe-grid-sheet">
        {RPE_CHOICES.map((n) => (
          <button
            key={n}
            type="button"
            // focus lands on the chips: the selected one, else the first
            data-sheet-autofocus={n === (value ?? RPE_CHOICES[0]) ? "" : undefined}
            className={`seg-btn rpe-btn ${value === n ? "seg-on" : ""}`}
            aria-pressed={value === n}
            aria-label={`rpe ${n}`}
            onClick={() => onChange(value === n ? null : n)}
          >
            {n}
          </button>
        ))}
      </div>
      {loggedRows && (
        <>
          <div className="rpe-sheet-heading">{loggedHeading}</div>
          <div className="rpe-sheet-rows">{loggedRows}</div>
        </>
      )}
      {onMore && (
        <button
          type="button"
          className="btn btn-outline-ink btn-block"
          onClick={onMore}
        >
          More for this exercise
        </button>
      )}
    </Sheet>
  );
}
