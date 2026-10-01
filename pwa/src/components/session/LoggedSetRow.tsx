// One logged set as a ledger row: where it sits, what it was, a quiet receipt
// mark, and the two things you can do to it — tap the numbers to fix it, or
// void it. The same row is drawn in List's current card and in the RPE sheet,
// so a set reads the same wherever it is found.
//
// A voided row never reaches here: voided sets leave `sets`, so there is no
// way to offer Fix on a row that is already hidden (C2).

import type { ReactNode } from "react";

export interface LoggedSetRowProps {
  /** "1", "W1": the set as the lifter counts it */
  label: string;
  /** a spoken position for the buttons: "set 2", "warmup 1" */
  position: string;
  /** "135 lb × 8" */
  text: string;
  /** "RPE 8 · rest 2:05" */
  meta?: string;
  note?: string;
  receipt?: ReactNode;
  /** absent for a tick, which has no numbers to correct */
  onFix?: () => void;
  onVoid?: () => void;
  voidArmed?: boolean;
  onArmVoid?: () => void;
  editing?: boolean;
}

export function LoggedSetRow({
  label,
  position,
  text,
  meta,
  note,
  receipt,
  onFix,
  onVoid,
  voidArmed = false,
  onArmVoid,
  editing = false,
}: LoggedSetRowProps) {
  const body = (
    <>
      <span className="ledger-set-n">{label}</span>
      <span className="ledger-set-text">
        {text}
        {meta && <span className="ledger-set-meta"> · {meta}</span>}
      </span>
    </>
  );
  return (
    <div className={`ledger-set${editing ? " ledger-set-editing" : ""}`}>
      {onFix ? (
        <button
          type="button"
          className="ledger-set-main"
          aria-label={`Correct logged ${position}: ${text}`}
          aria-pressed={editing}
          onClick={onFix}
        >
          {body}
        </button>
      ) : (
        <span className="ledger-set-main">{body}</span>
      )}
      {receipt && <span className="ledger-set-receipt">{receipt}</span>}
      {onVoid && (
        <button
          type="button"
          className={`ledger-set-void${voidArmed ? " is-armed" : ""}`}
          aria-label={
            voidArmed ? `Confirm void logged ${position}` : `Void logged ${position}`
          }
          onClick={() => (voidArmed ? onVoid() : onArmVoid?.())}
        >
          {voidArmed ? "VOID?" : "✕"}
        </button>
      )}
      {note && <span className="ledger-set-note">{note}</span>}
    </div>
  );
}
