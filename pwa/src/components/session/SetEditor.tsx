import type { ReactNode } from "react";
import { PlateBar } from "../PlateBar";
import { RpeChips } from "../RpeChips";
import { Stepper, stepTo, type StepDef } from "../Stepper";
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
    /** No implement at all — a bodyweight movement. Showing a load field here
     *  would be a fake zero someone has to read past, not a fact the app
     *  knows. Reps become the only editable number. */
    noLoad?: boolean;
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
  /** One compact, movement-specific previous performance for the focus hero.
   *  Session derives this from the selected entry, so substitutions never
   *  quote history from the planned movement. */
  lastPerformance?: string | null;
  /** Whether this entry has ANY prescribed warmup — gates the hero's own
   *  warmup/working toggle and "Already warm". Focus mode only; overview
   *  keeps its existing unconditional seg-types row. */
  hasWarmupBracket?: boolean;
  /** "Already warm": stage working and log nothing. Shown only alongside
   *  the hero toggle, and only while the draft is staged as warmup. */
  onAlreadyWarm?(): void;
  /** "Last: 145 kg × 5 working" — the newest logged set for this entry,
   *  tappable to open its correction. Null (or omitted) when nothing has
   *  been logged yet, or for a tick exercise. */
  lastSetLine?: string | null;
  onEditLastSet?(): void;
  /** The rest clock, when Session has one running — rendered just above the
   *  bottom bar instead of Session's own fixed strip, so it reads as part of
   *  this set rather than a document-level ticker with the log action below
   *  it. Focus mode only; Session keeps its own strip for everything else. */
  restSlot?: ReactNode;
  onDraftChange(next: Partial<SetDraft>): void;
  onLog(): void;
  onOpenPlates(): void;
  onOpenPad?(kind: "load" | "reps"): void;
  onToggleLoadEntry(): void;
  onRevealRpe(): void;
}

const SET_TYPES: BracketKind[] = ["warmup", "working"];
const MAX_REPS = 100;
const REPS_STEP_UP: StepDef = { label: "+", delta: 1 };
const REPS_STEP_DOWN: StepDef = { label: "−", delta: -1 };

/** A big flanking step button for the focus bottom bar — same arithmetic and
 *  the same spoken label `Stepper`'s own row would use, so a caller cannot
 *  drift from what its value control announces. */
function BarStep({
  def,
  label,
  value,
  min,
  max,
  snap = false,
  onChange,
}: {
  def: StepDef;
  label: string;
  value: number;
  min: number;
  max: number;
  snap?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <button
      type="button"
      className="focus-bar-step"
      aria-label={`${def.delta > 0 ? "increase" : "decrease"} ${label} by ${
        def.announce ?? Math.abs(def.delta)
      }`}
      onClick={() => onChange(stepTo(value, def.delta, min, max, snap))}
    >
      {def.label}
    </button>
  );
}

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
  variant = "overview",
  lastPerformance = null,
  hasWarmupBracket = false,
  onAlreadyWarm,
  lastSetLine = null,
  onEditLastSet,
  restSlot,
  onDraftChange,
  onLog,
  onOpenPlates,
  onOpenPad,
  onToggleLoadEntry,
  onRevealRpe,
}: SetEditorProps) {
  const { perSide, totalKg, plateSplit, barKg, hint, canToggleEntry, noLoad } =
    loadPresentation;
  const loadSub = perSide
    ? `${toDisplay(totalKg, unit)} ${unit} total`
    : formatStoredTwin(draft.entryKg, unit);

  const focus = variant === "focus";
  // Bodyweight has nothing to load — reps is the only number, and the hero.
  const heroIsLoad = focus && tracking === "reps" && !noLoad;
  const heroIsReps = focus && tracking === "reps" && Boolean(noLoad);
  const coarseDown = loadSteps[0];
  const coarseUp = loadSteps[loadSteps.length - 1];

  const repsSection = (
    <section
      className={`rule-section ${heroIsReps ? "focus-hero-section" : ""}`}
    >
      {!focus && (
        <div className="section-head">
          <span className="field-label">REPS</span>
        </div>
      )}
      <Stepper
        label="reps"
        inline={!heroIsReps}
        accent={heroIsReps}
        display={String(draft.reps)}
        subText={focus ? "REPS" : undefined}
        onTapValue={
          onOpenPad === undefined ? undefined : () => onOpenPad("reps")
        }
        value={draft.reps}
        min={0}
        max={MAX_REPS}
        onChange={(reps) => onDraftChange({ reps: Math.round(reps) })}
        steps={focus ? [] : [REPS_STEP_DOWN, REPS_STEP_UP]}
      />
    </section>
  );

  const loadSection = (
    <section
      className={`rule-section ${heroIsLoad ? "focus-hero-section" : ""}`}
    >
      {!focus && (
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
      )}
      {!focus && canToggleEntry && (
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
        subText={heroIsLoad ? unit.toUpperCase() : loadSub}
        onTapValue={
          onOpenPad === undefined ? undefined : () => onOpenPad("load")
        }
        snap
        value={draft.entryKg}
        min={0}
        max={maxEntryKg}
        onChange={(entryKg) => onDraftChange({ entryKg })}
        steps={focus ? [] : loadSteps}
      />
      {/* Per-hand count only — never the lb/kg twin conversion the accordion
          shows (loadSub): that's a fine detail for the "more" sheet, not the
          hero. "15 × 2" is this app's own convention for a stored total
          entered as two matching implements (see CLAUDE.md's load_kg note). */}
      {heroIsLoad && perSide && (
        <div className="microcopy focus-load-detail">
          EACH HAND × 2 · {toDisplay(totalKg, unit)} {unit.toUpperCase()} TOTAL
        </div>
      )}
      {plateSplit && <PlateBar split={plateSplit} barKg={barKg} unit={unit} />}
    </section>
  );

  // The bottom bar is the focus deck's one big action: the hero's coarse
  // step flanking LOG. A superset member (`showLog={false}`) still needs its
  // own hero adjusted, so the bar renders without a middle log button then —
  // `SupersetRoundEditor` supplies the shared Log round / Log A1/A2 actions
  // below both members instead.
  const bottomBar = focus && tracking !== "done" && (
    <div className="focus-bar">
      {heroIsLoad && coarseDown && (
        <BarStep
          def={coarseDown}
          label="load"
          value={draft.entryKg}
          min={0}
          max={maxEntryKg}
          snap
          onChange={(entryKg) => onDraftChange({ entryKg })}
        />
      )}
      {heroIsReps && (
        <BarStep
          def={REPS_STEP_DOWN}
          label="reps"
          value={draft.reps}
          min={0}
          max={MAX_REPS}
          onChange={(reps) => onDraftChange({ reps: Math.round(reps) })}
        />
      )}
      {showLog ? (
        <button
          type="button"
          className={`${logClassName} focus-bar-log`}
          disabled={disabled}
          onClick={onLog}
        >
          {logLabel}
        </button>
      ) : (
        <span className="focus-bar-spacer" />
      )}
      {heroIsLoad && coarseUp && (
        <BarStep
          def={coarseUp}
          label="load"
          value={draft.entryKg}
          min={0}
          max={maxEntryKg}
          snap
          onChange={(entryKg) => onDraftChange({ entryKg })}
        />
      )}
      {heroIsReps && (
        <BarStep
          def={REPS_STEP_UP}
          label="reps"
          value={draft.reps}
          min={0}
          max={MAX_REPS}
          onChange={(reps) => onDraftChange({ reps: Math.round(reps) })}
        />
      )}
    </div>
  );

  const heroContent =
    tracking === "done" ? (
      focus ? null : (
        <section className="rule-section">
          <p className="microcopy">
            No numbers for this one — tap below each time you finish a set.
          </p>
        </section>
      )
    ) : heroIsLoad ? (
      <>
        {loadSection}
        {repsSection}
      </>
    ) : (
      <>
        {repsSection}
        {(!focus || !noLoad) && loadSection}
      </>
    );

  return (
    <div className={`set-editor ${focus ? "set-editor-focus" : ""}`}>
      {!focus && (
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
      )}

      {/* Focus wraps the hero in one group so the whole thing (not each
          piece separately) can be given equal auto margins above and below,
          leaving the name/position pinned at the top and the bottom bar
          pinned at the bottom. Overview keeps the plain, ungrouped markup it
          always had — .set-editor's own gap already sets its rhythm. */}
      {focus ? (
        <div className="focus-hero-group">{heroContent}</div>
      ) : (
        <>
          {heroContent}
          <RpeChips
            shown={rpeShown}
            value={draft.rpe}
            onChange={(rpe) => onDraftChange({ rpe })}
          />
        </>
      )}

      {focus && tracking !== "done" && hasWarmupBracket && (
        <div className="focus-hero-warmup">
          <div className="seg seg-types">
            {SET_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={`seg-btn ${draft.setType === t ? "seg-on" : ""}`}
                onClick={() => onDraftChange({ setType: t })}
              >
                {t}
              </button>
            ))}
          </div>
          {draft.setType === "warmup" && onAlreadyWarm && (
            <button
              type="button"
              className="btn btn-ghost focus-already-warm"
              onClick={onAlreadyWarm}
            >
              Already warm
            </button>
          )}
        </div>
      )}

      {focus && tracking !== "done" && lastSetLine && onEditLastSet && (
        <button type="button" className="focus-last-set" onClick={onEditLastSet}>
          {lastSetLine}
        </button>
      )}

      {focus && tracking !== "done" && lastPerformance !== null && (
        <p className="focus-last-performance">{lastPerformance}</p>
      )}

      {focus && restSlot}
      {bottomBar}

      {!focus && showLog && (
        <button
          type="button"
          className={logClassName}
          disabled={disabled}
          onClick={onLog}
        >
          {logLabel}
        </button>
      )}
      {focus && tracking === "done" && showLog && (
        <button
          type="button"
          className={`${logClassName} focus-bar-log focus-tick-log`}
          disabled={disabled}
          onClick={onLog}
        >
          {logLabel}
        </button>
      )}
    </div>
  );
}
