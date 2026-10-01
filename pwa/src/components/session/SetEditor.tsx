import type { ReactElement, ReactNode } from "react";
import { DumbbellIcon, KettlebellIcon } from "../icons/LoadIcons";
import { PlateBar } from "../PlateBar";
import { RpeChips } from "../RpeChips";
import { Stepper, stepTo, type StepDef } from "../Stepper";
import type { BracketKind, ExerciseEntry } from "../../lib/entries";
import { formatStoredTwin } from "../../lib/format";
import type { PlateSplit } from "../../lib/plates";
import { stagedDisplayLoad, toDisplay, type Unit } from "../../lib/units";

export type SetDraft = {
  entryKg: number;
  reps: number;
  setType: BracketKind;
  rpe: number | null;
  durationSeconds?: number;
  /** Exact authored input, kept beside canonical kg while a draft is staged. */
  enteredLoad?: number;
  enteredUnit?: Unit;
};

export interface SetEditorProps {
  entry: ExerciseEntry;
  draft: SetDraft;
  tracking: "reps" | "done" | "time";
  loadPresentation: {
    perSide: boolean;
    totalKg: number;
    plateSplit: PlateSplit | null;
    barKg: number;
    hint: string | null;
    canToggleEntry: boolean;
    /** No implement at all — a bodyweight movement. Showing a load field here
     *  would be a fake zero someone has to read past, not a fact the app
     *  knows. Reps become the only editable number. */
    noLoad?: boolean;
    /** The load-mode glyph for this exercise: a fixed barbell, or a
     *  plates<->stack toggle for machine/cable work. Absent for hand-held
     *  implements and bodyweight, which have no bar/pin concept at all —
     *  those show only `perSideIcon` below, inside the existing per-hand
     *  toggle. */
    styleIcon?: {
      Icon: (props: { size?: number; count?: 1 | 2 }) => ReactElement;
      label: string;
      /** present only when this exercise offers the toggle (machine/cable);
       *  a barbell's icon is fixed and never receives one. */
      onToggle?: () => void;
    } | null;
    /** Which bell glyph to show inside the existing per-hand toggle button.
     *  Purely cosmetic — the toggle itself stays `onToggleLoadEntry`. */
    perSideIcon?: "dumbbell" | "kettlebell" | null;
  };
  unit: Unit;
  maxEntryKg: number;
  loadSteps: StepDef[];
  nearbyLoads?: number[];
  onChooseNearbyLoad?(value: number): void;
  rpeShown: boolean;
  logLabel: string;
  logClassName?: string;
  /** A paired round supplies one shared commit action outside both editors. */
  showLog?: boolean;
  disabled: boolean;
  /**
   * "overview" (default) is the accordion's long-standing layout: every
   * control inline, reps then load, both with their own step row. "focus" is
   * the one-exercise deck, and it is deliberately spare: whichever number is
   * hard to get right for THIS movement (load for a loaded implement, reps
   * for bodyweight) is the ONLY thing with visual weight besides the log
   * action. Its coarse step moves into a bottom bar flanking LOG; everything
   * else this component would normally render inline for it (set type, RPE,
   * the per-hand/plate toggles, fine adjustment) is left to the caller's own
   * "more" surface — Session already owns those handlers, so nothing here
   * needs a second copy of them to expose them from two places.
   */
  variant?: "overview" | "focus";
  /** One compact, movement-specific previous performance. Read by a
   *  superset member's row; the single-exercise focus deck shows its own
   *  "Last time" line in the middle of the screen instead. */
  lastPerformance?: string | null;
  /** Focus only: the four small keys, rendered between the numbers and LOG. */
  keysSlot?: ReactNode;
  /** Focus only, bodyweight movements: reps stay the big number and any
   *  added load (belt, vest) is a small secondary row under them. `on` while
   *  that row is showing; `onRemove` sets the load back to nothing. */
  addedLoad?: { on: boolean; onRemove(): void } | null;
  onDraftChange(next: Partial<SetDraft>): void;
  onLog(): void;
  onOpenPlates(): void;
  onOpenPad?(kind: "load" | "reps" | "duration"): void;
  onToggleLoadEntry(): void;
  onRevealRpe(): void;
}

const SET_TYPES: BracketKind[] = ["warmup", "working"];
const MAX_REPS = 100;
const REPS_STEP_UP: StepDef = { label: "+", delta: 1 };
const REPS_STEP_DOWN: StepDef = { label: "−", delta: -1 };


/** One number card in the focus dock: − value + , the value itself a button
 *  onto the number pad when one is offered. Same `stepTo` arithmetic the
 *  overview's Stepper uses, so the two can never land on different values. */
function DockNumber({
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
  onChange(next: number): void;
  onTap?(): void;
}) {
  const say = (def: StepDef) =>
    `${def.delta > 0 ? "increase" : "decrease"} ${label} by ${def.announce ?? Math.abs(def.delta)}`;
  const valueBody = (
    <>
      <span className="dock-num-value">{display}</span>
      <span className="dock-num-caption">{caption}</span>
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
          aria-label={`${label} ${display} ${caption}, tap to type`}
          onClick={onTap}
        >
          {valueBody}
        </button>
      ) : (
        <div className="dock-num-body" aria-label={`${label} ${display} ${caption}`}>
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

/**
 * The focus deck's dock: the numbers for the set being staged, the four
 * small keys, and LOG — in that order, so the commit is always the last
 * thing under the thumb. Load and reps sit side by side in one row; for a
 * bodyweight movement reps are the one big number and any added load is a
 * small secondary row under them.
 */
function FocusDock({
  entry,
  draft,
  tracking,
  loadPresentation,
  unit,
  maxEntryKg,
  loadSteps,
  logLabel,
  logClassName = "btn btn-primary btn-log",
  showLog = true,
  disabled,
  keysSlot,
  addedLoad = null,
  onDraftChange,
  onLog,
  onOpenPad,
}: SetEditorProps) {
  const { perSide, noLoad } = loadPresentation;
  const displayedLoad = stagedDisplayLoad(
    draft.entryKg, draft.enteredLoad, draft.enteredUnit, unit,
  );
  const coarseDown = loadSteps[0] ?? { label: "−", delta: -1 };
  const coarseUp = loadSteps[loadSteps.length - 1] ?? { label: "+", delta: 1 };
  const setLoad = (entryKg: number) =>
    onDraftChange({ entryKg, enteredLoad: undefined, enteredUnit: undefined });
  const setReps = (reps: number) => onDraftChange({ reps: Math.round(reps) });
  const durationSeconds = draft.durationSeconds ?? 60;
  const repsOnly = Boolean(noLoad) || addedLoad !== null;

  const loadCard = (
    <DockNumber
      label="load"
      display={String(displayedLoad)}
      caption={perSide ? `${unit} each` : unit}
      value={draft.entryKg}
      min={0}
      max={maxEntryKg}
      down={coarseDown}
      up={coarseUp}
      snap
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
    numbers = (
      <DockNumber
        label="duration"
        display={String(durationSeconds)}
        caption="sec"
        value={durationSeconds}
        min={0}
        max={3600}
        down={{ label: "−", delta: -5, announce: "5 seconds" }}
        up={{ label: "+", delta: 5, announce: "5 seconds" }}
        big
        onChange={(v) => onDraftChange({ durationSeconds: Math.round(v) })}
        onTap={onOpenPad ? () => onOpenPad("duration") : undefined}
      />
    );
  } else if (tracking === "reps" && repsOnly) {
    numbers = (
      <>
        {repsCard(true)}
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
              onClick={() => setLoad(stepTo(draft.entryKg, coarseDown.delta, 0, maxEntryKg, true))}
            >
              −
            </button>
            <button
              type="button"
              className="dock-mini-step"
              aria-label={`increase added load by ${coarseUp.announce ?? Math.abs(coarseUp.delta)}`}
              onClick={() => setLoad(stepTo(draft.entryKg, coarseUp.delta, 0, maxEntryKg, true))}
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
    <div className="set-editor set-editor-focus" aria-label={`${entry.name} set`}>
      {numbers}
      {keysSlot}
      {showLog && (
        <button
          type="button"
          className={`${logClassName} focus-log`}
          disabled={disabled}
          onClick={onLog}
        >
          {logLabel}
        </button>
      )}
    </div>
  );
}

/**
 * The staged set controls shared by normal and tick-only exercises.
 *
 * This component deliberately owns no draft state and never persists anything:
 * Session decides when the callbacks are safe to accept and records the result.
 */
export function SetEditor(props: SetEditorProps) {
  if (props.variant === "focus") return <FocusDock {...props} />;
  const {
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
  } = props;
  const {
    perSide,
    totalKg,
    plateSplit,
    barKg,
    hint,
    canToggleEntry,
    noLoad,
    styleIcon,
    perSideIcon,
  } = loadPresentation;
  const loadSub = perSide
    ? `${toDisplay(totalKg, unit)} ${unit} total`
    : formatStoredTwin(draft.entryKg, unit);

  const durationSeconds = draft.durationSeconds ?? 60;
  const displayedLoad = stagedDisplayLoad(
    draft.entryKg, draft.enteredLoad, draft.enteredUnit, unit,
  );

  const repsSection = (
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
        steps={[REPS_STEP_DOWN, REPS_STEP_UP]}
      />
    </section>
  );

  const durationSection = (
    <section className="rule-section">
      <div className="section-head"><span className="field-label">DURATION · SEC</span></div>
      <Stepper
        label="duration"
        accent
        display={String(durationSeconds)}
        subText="SECONDS"
        onTapValue={onOpenPad === undefined ? undefined : () => onOpenPad("duration")}
        value={durationSeconds}
        min={0}
        max={3600}
        onChange={(value) => onDraftChange({ durationSeconds: Math.round(value) })}
        steps={[{ label: "− 5", delta: -5 }, { label: "+ 5", delta: 5 }]}
      />
    </section>
  );

  const loadSection = (
    <section className="rule-section">
      <div className="section-head">
        <span className="field-label">LOAD · {unit.toUpperCase()}</span>
        {styleIcon &&
          (styleIcon.onToggle ? (
            <button
              type="button"
              className="plate-hint load-style-icon"
              aria-label={styleIcon.label}
              onClick={styleIcon.onToggle}
            >
              <styleIcon.Icon size={16} />
            </button>
          ) : (
            <span
              className="plate-hint load-style-icon"
              role="img"
              aria-label={styleIcon.label}
            >
              <styleIcon.Icon size={16} />
            </span>
          ))}
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
            {perSideIcon === "dumbbell" && (
              <DumbbellIcon size={14} count={perSide ? 2 : 1} />
            )}
            {perSideIcon === "kettlebell" && (
              <KettlebellIcon size={14} count={perSide ? 2 : 1} />
            )}
            {perSide ? "EACH HAND ×2" : "ONE TOTAL WEIGHT"}
          </button>
        )}
        {hint !== null && (
          <button type="button" className="plate-hint" onClick={onOpenPlates}>
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
        display={String(displayedLoad)}
        subText={loadSub}
        onTapValue={
          onOpenPad === undefined ? undefined : () => onOpenPad("load")
        }
        snap
        value={draft.entryKg}
        min={0}
        max={maxEntryKg}
        onChange={(entryKg) => onDraftChange({ entryKg, enteredLoad: undefined, enteredUnit: undefined })}
        steps={loadSteps}
      />
      {plateSplit && <PlateBar split={plateSplit} barKg={barKg} unit={unit} />}
    </section>
  );

  const heroContent =
    tracking === "done" ? (
      <section className="rule-section">
        <p className="microcopy">
          No numbers for this one — tap below each time you finish a set.
        </p>
      </section>
    ) : tracking === "time" ? (
      <>
        {durationSection}
        {!noLoad && loadSection}
      </>
    ) : (
      <>
        {repsSection}
        {loadSection}
      </>
    );

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

      {heroContent}
      <RpeChips
        shown={rpeShown}
        value={draft.rpe}
        onChange={(rpe) => onDraftChange({ rpe })}
      />

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
