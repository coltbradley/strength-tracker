// Fix a logged set. A correction is a void of the old row plus a replacement
// at the same place (lib/corrections.ts), so this sheet says so in the words
// the design uses: the record keeps the original, hidden, and the corrected
// set takes the same place.
//
// It edits a draft of its OWN. The next set being staged in the dock is never
// touched, and the load convention (per hand or total, the step sizes, the
// maximum) comes from the exercise the SET belongs to, not from whichever
// exercise happens to be open — that mix-up once saved a bench set as "12.5 ×
// 2" because the dumbbell row was open when Fix was tapped (C1).

import { Sheet } from "../Sheet";
import { DockNumber, MAX_REPS, REPS_STEP_DOWN, REPS_STEP_UP } from "./SetEditor";
import { RPE_CHOICES } from "../../lib/rpe";
import type { StepDef } from "../Stepper";
import type { Unit } from "../../lib/units";
import type { SetType } from "../../lib/types";

export interface CorrectionSheetProps {
  /** "Fix set 2" */
  title: string;
  /** "Bench Press · logged 135 lb × 8" */
  summary: string;
  unit: Unit;
  perSide: boolean;
  /** a timed set has no reps to correct */
  showReps: boolean;
  /** absent when the movement has no implement and no load was logged */
  load: {
    display: number;
    entryKg: number;
    maxEntryKg: number;
    steps: StepDef[];
  } | null;
  reps: number;
  setType: SetType;
  rpe: number | null;
  onLoadChange(entryKg: number): void;
  onRepsChange(reps: number): void;
  onSetType(next: "warmup" | "working"): void;
  onRpe(next: number | null): void;
  onOpenPad(kind: "load" | "reps"): void;
  onSave(): void;
  onCancel(): void;
  saving?: boolean;
}

export function CorrectionSheet({
  title,
  summary,
  unit,
  perSide,
  showReps,
  load,
  reps,
  setType,
  rpe,
  onLoadChange,
  onRepsChange,
  onSetType,
  onRpe,
  onOpenPad,
  onSave,
  onCancel,
  saving = false,
}: CorrectionSheetProps) {
  const down = load?.steps[0] ?? { label: "−", delta: -1 };
  const up = load?.steps[(load?.steps.length ?? 1) - 1] ?? { label: "+", delta: 1 };
  return (
    <Sheet title={title} onClose={onCancel} className="correction-sheet">
      <p className="correction-summary">{summary}</p>
      <div className="correction-numbers">
        {load && (
          <DockNumber
            label="load"
            display={String(load.display)}
            caption={perSide ? `${unit} each` : unit}
            value={load.entryKg}
            min={0}
            max={load.maxEntryKg}
            down={down}
            up={up}
            snap
            onChange={onLoadChange}
            onTap={() => onOpenPad("load")}
          />
        )}
        {showReps && (
          <DockNumber
            label="reps"
            display={String(reps)}
            caption="reps"
            value={reps}
            min={0}
            max={MAX_REPS}
            down={REPS_STEP_DOWN}
            up={REPS_STEP_UP}
            onChange={onRepsChange}
            onTap={() => onOpenPad("reps")}
          />
        )}
      </div>
      <div className="seg seg-types" role="group" aria-label="Set type">
        {(["warmup", "working"] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`seg-btn ${setType === t ? "seg-on" : ""}`}
            aria-pressed={setType === t}
            onClick={() => onSetType(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="correction-rpe">
        <span className="correction-rpe-label">RPE · how hard, optional</span>
        <div className="rpe-grid rpe-grid-sheet">
          {RPE_CHOICES.map((n) => (
            <button
              key={n}
              type="button"
              className={`seg-btn rpe-btn ${rpe === n ? "seg-on" : ""}`}
              aria-pressed={rpe === n}
              aria-label={`rpe ${n}`}
              onClick={() => onRpe(rpe === n ? null : n)}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
      <p className="microcopy">
        Your record keeps the original, hidden. The corrected set takes the same
        place.
      </p>
      <button
        type="button"
        className="btn btn-primary btn-block btn-log"
        disabled={saving}
        onClick={onSave}
      >
        {saving ? "Saving…" : "Save correction"}
      </button>
      <button type="button" className="btn btn-ghost btn-block" onClick={onCancel}>
        Cancel
      </button>
    </Sheet>
  );
}
