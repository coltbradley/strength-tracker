import { PlateBar } from "../PlateBar";
import { RpeChips } from "../RpeChips";
import { Stepper, type StepDef } from "../Stepper";
import type { BracketKind, ExerciseEntry } from "../../lib/entries";
import { formatStoredTwin } from "../../lib/format";
import type { PlateSplit } from "../../lib/plates";
import { toDisplay, type Unit } from "../../lib/units";

export type SetDraft = {
  entryKg: number;
  reps: number;
  setType: BracketKind;
  rpe: number | null;
};

export interface SetEditorProps {
  entry: ExerciseEntry;
  draft: SetDraft;
  tracking: "reps" | "done";
  loadPresentation: {
    perSide: boolean;
    totalKg: number;
    plateSplit: PlateSplit | null;
    barKg: number;
    hint: string | null;
    canToggleEntry: boolean;
  };
  unit: Unit;
  maxEntryKg: number;
  loadSteps: StepDef[];
  rpeShown: boolean;
  logLabel: string;
  logClassName?: string;
  /** A paired round supplies one shared commit action outside both editors. */
  showLog?: boolean;
  disabled: boolean;
  onDraftChange(next: Partial<SetDraft>): void;
  onLog(): void;
  onOpenPlates(): void;
  onOpenPad?(kind: "load" | "reps"): void;
  onToggleLoadEntry(): void;
  onRevealRpe(): void;
}

const SET_TYPES: BracketKind[] = ["warmup", "working"];
const MAX_REPS = 100;

/**
 * The staged set controls shared by normal and tick-only exercises.
 *
 * This component deliberately owns no draft state and never persists anything:
 * Session decides when the callbacks are safe to accept and records the result.
 */
export function SetEditor({
  entry,
  draft,
  tracking,
  loadPresentation,
  unit,
  maxEntryKg,
  loadSteps,
  rpeShown,
  logLabel,
  logClassName = "btn btn-primary btn-log",
  showLog = true,
  disabled,
  onDraftChange,
  onLog,
  onOpenPlates,
  onOpenPad,
  onToggleLoadEntry,
  onRevealRpe,
}: SetEditorProps) {
  const { perSide, totalKg, plateSplit, barKg, hint, canToggleEntry } =
    loadPresentation;
  const loadSub = perSide
    ? `${toDisplay(totalKg, unit)} ${unit} total`
    : formatStoredTwin(draft.entryKg, unit);

  return (
    <div className="set-editor">
      <div className="seg seg-types">
        {SET_TYPES.map((setType) => (
          <button
            key={setType}
            type="button"
            className={`seg-btn ${draft.setType === setType ? "seg-on" : ""}`}
            onClick={() => onDraftChange({ setType })}
          >
            {setType}
          </button>
        ))}
      </div>

      {tracking === "done" ? (
        <section className="rule-section">
          <p className="microcopy">
            No numbers for this one — tap below each time you finish a set.
          </p>
        </section>
      ) : (
        <>
          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">REPS</span>
            </div>
            <Stepper
              label="reps"
              inline
              display={String(draft.reps)}
              onTapValue={
                onOpenPad === undefined ? undefined : () => onOpenPad("reps")
              }
              value={draft.reps}
              min={0}
              max={MAX_REPS}
              onChange={(reps) => onDraftChange({ reps: Math.round(reps) })}
              steps={[
                { label: "−", delta: -1 },
                { label: "+", delta: 1 },
              ]}
            />
          </section>

          <section className="rule-section">
            <div className="section-head">
              <span className="field-label">LOAD · {unit.toUpperCase()}</span>
              {canToggleEntry && (
                <button
                  type="button"
                  className="plate-hint"
                  aria-label={
                    perSide
                      ? "one dumbbell in each hand; switch to one total weight"
                      : "one total weight; switch to one dumbbell in each hand"
                  }
                  onClick={onToggleLoadEntry}
                >
                  {perSide ? "EACH HAND ×2" : "ONE TOTAL WEIGHT"}
                </button>
              )}
              {hint !== null && (
                <button
                  type="button"
                  className="plate-hint"
                  onClick={onOpenPlates}
                >
                  {hint} ›
                </button>
              )}
              {!rpeShown && (
                <button
                  type="button"
                  className="rpe-reveal"
                  aria-label={`add an RPE rating to ${entry.name}`}
                  onClick={onRevealRpe}
                >
                  + RPE
                </button>
              )}
            </div>
            {canToggleEntry && (
              <div className="microcopy">
                {perSide
                  ? "Enter the weight on each dumbbell. The app counts both together."
                  : "Enter one total weight. Use this for one dumbbell or single-side work."}
              </div>
            )}
            {perSide && (
              <span className="sr-only">
                {toDisplay(draft.entryKg, unit)} {unit} per hand
              </span>
            )}
            <Stepper
              label="load"
              accent
              display={String(toDisplay(draft.entryKg, unit))}
              subText={loadSub}
              onTapValue={
                onOpenPad === undefined ? undefined : () => onOpenPad("load")
              }
              snap
              value={draft.entryKg}
              min={0}
              max={maxEntryKg}
              onChange={(entryKg) => onDraftChange({ entryKg })}
              steps={loadSteps}
            />
            {plateSplit && (
              <PlateBar split={plateSplit} barKg={barKg} unit={unit} />
            )}
          </section>

          <RpeChips
            shown={rpeShown}
            value={draft.rpe}
            onChange={(rpe) => onDraftChange({ rpe })}
          />
        </>
      )}

      {showLog && (
        <button
          type="button"
          className={logClassName}
          disabled={disabled}
          onClick={onLog}
        >
          {logLabel}
        </button>
      )}
    </div>
  );
}
