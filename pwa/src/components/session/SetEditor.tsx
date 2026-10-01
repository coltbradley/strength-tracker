// The staged set, as the dock: the numbers for the set about to be logged, the
// four small keys, and LOG — in that order, so the commit is always the last
// thing under the thumb. Load and reps sit side by side in one row; for a
// bodyweight movement reps are the one big number and any added load is a
// small secondary row under them; a timed set has its duration and, because a
// weighted carry records both, its load too.
//
// This component owns no draft state and never persists anything: Session
// decides when the callbacks are safe to accept and records the result. It is
// also the ONE editor — the same dock sits at the bottom of Focus and inside
// the current card of List, and a correction is its own sheet
// (CorrectionSheet), so there is no second, differently-styled copy of these
// controls to keep in step.

import type { ReactNode } from "react";
import { stepTo, type StepDef } from "../Stepper";
import type { BracketKind, ExerciseEntry } from "../../lib/entries";
import { stagedDisplayLoad, type Unit } from "../../lib/units";
import { formatPlanRef, type PlanRef } from "../../lib/displayLoad";

export type SetDraft = {
  entryKg: number;
  reps: number;
  setType: BracketKind;
  rpe: number | null;
  durationSeconds?: number;
  /** Exact authored input, kept beside canonical kg while a draft is staged. */
  enteredLoad?: number;
  enteredUnit?: Unit;
  /** Where a staged number that crossed units came from ("plan 100 kg"). */
  planRef?: PlanRef;
};

export interface SetEditorProps {
  entry: ExerciseEntry;
  draft: SetDraft;
  tracking: "reps" | "done" | "time";
  loadPresentation: {
    perSide: boolean;
    /** No implement at all — a bodyweight movement. Showing a load field here
     *  would be a fake zero someone has to read past, not a fact the app
     *  knows. Reps become the only editable number. */
    noLoad?: boolean;
  };
  unit: Unit;
  maxEntryKg: number;
  loadSteps: StepDef[];
  logLabel: string;
  logClassName?: string;
  /** The log is in flight: the button says so and cannot be pressed again. */
  saving?: boolean;
  disabled: boolean;
  /** The four small keys, rendered between the numbers and LOG. */
  keysSlot?: ReactNode;
  /** "A1" in a superset round, so the load card's caption names whose number
   *  this is ("lb · A1"). */
  memberTag?: string;
  /** Bodyweight movements: reps stay the big number and any added load (belt,
   *  vest) is a small secondary row under them. `on` while that row is
   *  showing; `onRemove` sets the load back to nothing. */
  addedLoad?: { on: boolean; onRemove(): void; onAdd?(): void } | null;
  onDraftChange(next: Partial<SetDraft>): void;
  onLog(): void;
  onOpenPad?(kind: "load" | "reps" | "duration"): void;
}

export const MAX_REPS = 100;
export const REPS_STEP_UP: StepDef = { label: "+", delta: 1 };
export const REPS_STEP_DOWN: StepDef = { label: "−", delta: -1 };

/** One number card in the dock: − value + , the value itself a button onto the
 *  number pad when one is offered. Same `stepTo` arithmetic the plan editor's
 *  Stepper uses, so the two can never land on different values. */
export function DockNumber({
  label,
  display,
  caption,
  value,
  min,
  max,
  down,
  up,
  snap = false,
  big = false,
  note,
  onChange,
  onTap,
}: {
  label: string;
  display: string;
  caption: string;
  value: number;
  min: number;
  max: number;
  down: StepDef;
  up: StepDef;
  snap?: boolean;
  big?: boolean;
  /** Quiet reference under the caption ("plan 100 kg"). */
  note?: string | null;
  onChange(next: number): void;
  onTap?(): void;
}) {
  const say = (def: StepDef) =>
    `${def.delta > 0 ? "increase" : "decrease"} ${label} by ${def.announce ?? Math.abs(def.delta)}`;
  const valueBody = (
    <>
      <span className="dock-num-value">{display}</span>
      <span className="dock-num-caption">{caption}</span>
      {note && <span className="dock-num-note">{note}</span>}
    </>
  );
  return (
    <div className={`dock-num${big ? " dock-num-big" : ""}`}>
      <button
        type="button"
        className="dock-num-step"
        aria-label={say(down)}
        onClick={() => onChange(stepTo(value, down.delta, min, max, snap))}
      >
        −
      </button>
      {onTap ? (
        <button
          type="button"
          className="dock-num-body"
          aria-label={`${label} value — tap to type`}
          onClick={onTap}
        >
          {valueBody}
        </button>
      ) : (
        <div
          className="dock-num-body"
          role="group"
          aria-label={`${label} ${display} ${caption}`}
        >
          {valueBody}
        </div>
      )}
      <button
        type="button"
        className="dock-num-step"
        aria-label={say(up)}
        onClick={() => onChange(stepTo(value, up.delta, min, max, snap))}
      >
        +
      </button>
    </div>
  );
}

export function SetEditor({
  entry,
  draft,
  tracking,
  loadPresentation,
  unit,
  maxEntryKg,
  loadSteps,
  logLabel,
  logClassName = "btn btn-primary btn-log",
  saving = false,
  disabled,
  keysSlot,
  memberTag,
  addedLoad = null,
  onDraftChange,
  onLog,
  onOpenPad,
}: SetEditorProps) {
  const { perSide, noLoad } = loadPresentation;
  const displayedLoad = stagedDisplayLoad(
    draft.entryKg,
    draft.enteredLoad,
    draft.enteredUnit,
    unit,
  );
  const coarseDown = loadSteps[0] ?? { label: "−", delta: -1 };
  const coarseUp = loadSteps[loadSteps.length - 1] ?? { label: "+", delta: 1 };
  const setLoad = (entryKg: number) =>
    onDraftChange({ entryKg, enteredLoad: undefined, enteredUnit: undefined });
  const setReps = (reps: number) => onDraftChange({ reps: Math.round(reps) });
  const durationSeconds = draft.durationSeconds ?? 60;
  const repsOnly =
    tracking === "reps" && (Boolean(noLoad) || addedLoad !== null);

  const loadCard = (
    <DockNumber
      label="load"
      display={String(displayedLoad)}
      caption={`${perSide ? `${unit} each` : unit}${memberTag ? ` · ${memberTag}` : ""}`}
      value={draft.entryKg}
      min={0}
      max={maxEntryKg}
      down={coarseDown}
      up={coarseUp}
      snap
      note={formatPlanRef(draft.planRef, unit)}
      onChange={setLoad}
      onTap={onOpenPad ? () => onOpenPad("load") : undefined}
    />
  );
  const repsCard = (big: boolean) => (
    <DockNumber
      label="reps"
      display={String(draft.reps)}
      caption="reps"
      value={draft.reps}
      min={0}
      max={MAX_REPS}
      down={REPS_STEP_DOWN}
      up={REPS_STEP_UP}
      big={big}
      onChange={setReps}
      onTap={onOpenPad ? () => onOpenPad("reps") : undefined}
    />
  );

  let numbers: ReactNode = null;
  if (tracking === "time") {
    // A weighted carry or hold records what was carried AND for how long, so a
    // timed set keeps its load control beside the duration (M3).
    numbers = (
      <div className={noLoad ? undefined : "dock-row dock-row-time"}>
        {!noLoad && loadCard}
        <DockNumber
          label="duration"
          display={String(durationSeconds)}
          caption="sec"
          value={durationSeconds}
          min={0}
          max={3600}
          down={{ label: "−", delta: -5, announce: "5 seconds" }}
          up={{ label: "+", delta: 5, announce: "5 seconds" }}
          big={Boolean(noLoad)}
          onChange={(v) => onDraftChange({ durationSeconds: Math.round(v) })}
          onTap={onOpenPad ? () => onOpenPad("duration") : undefined}
        />
      </div>
    );
  } else if (repsOnly) {
    numbers = (
      <>
        {repsCard(true)}
        {/* In the dock, not the picture: the picture gives way to the rest
            panel, and a rest is when the belt goes on (N6). */}
        {addedLoad && !addedLoad.on && addedLoad.onAdd && (
          <button type="button" className="text-link dock-add-load" onClick={addedLoad.onAdd}>
            + Add load (belt or vest)
          </button>
        )}
        {addedLoad?.on && (
          <div className="dock-added-load">
            <span className="dock-added-load-text">
              <b>
                + {displayedLoad} {unit}
              </b>{" "}
              <span className="muted">added</span>
            </span>
            <button
              type="button"
              className="dock-mini-step"
              aria-label={`decrease added load by ${coarseDown.announce ?? Math.abs(coarseDown.delta)}`}
              onClick={() =>
                setLoad(
                  stepTo(draft.entryKg, coarseDown.delta, 0, maxEntryKg, true),
                )
              }
            >
              −
            </button>
            <button
              type="button"
              className="dock-mini-step"
              aria-label={`increase added load by ${coarseUp.announce ?? Math.abs(coarseUp.delta)}`}
              onClick={() =>
                setLoad(
                  stepTo(draft.entryKg, coarseUp.delta, 0, maxEntryKg, true),
                )
              }
            >
              +
            </button>
            <button
              type="button"
              className="dock-mini-step"
              aria-label="remove added load"
              onClick={addedLoad.onRemove}
            >
              ×
            </button>
          </div>
        )}
      </>
    );
  } else if (tracking === "reps") {
    numbers = (
      <div className="dock-row">
        {loadCard}
        {repsCard(false)}
      </div>
    );
  }

  return (
    <div
      className="set-editor set-editor-focus"
      role="group"
      aria-label={`${entry.name} set`}
    >
      {numbers}
      {keysSlot}
      <button
        type="button"
        className={`${logClassName} focus-log${saving ? " is-saving" : ""}`}
        disabled={disabled || saving}
        aria-busy={saving}
        onClick={onLog}
      >
        {saving ? "Saving…" : logLabel}
      </button>
    </div>
  );
}
