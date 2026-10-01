import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  targetSets,
  warmupSets,
  workingSets,
  type ExerciseEntry,
} from "../../lib/entries";
import { twoMemberSuperset } from "../../lib/sessionFocus";
import { StateGlyph, type ProgressState } from "./StateGlyph";

/** The four small keys between the numbers and LOG. Session decides which
 *  ones apply; FocusDeck lays them out and owns the inline skip prompt. */
export interface FocusKeys {
  /** RPE — opens the focused RPE sheet. `rpeValue` is the staged rating,
   *  shown on the key ("RPE 8") so a rating is visible without opening
   *  anything. */
  onRpe(): void;
  rpeValue?: number | null;
  /** Note — opens the note editor for the set it attaches to; null while
   *  there is no live set to attach to. */
  onNote: (() => void) | null;
  /** The fourth key: Swap before anything is logged, Fix last after. */
  fourth: { label: string; onPress(): void } | null;
}

export interface FocusDeckProps {
  entries: readonly ExerciseEntry[];
  entry: ExerciseEntry;
  entryProgress(entry: ExerciseEntry): number;
  entryDone(entry: ExerciseEntry): boolean;
  workoutComplete?: boolean;
  extraSetArmed?: boolean;
  onFinishWorkout?(): void;
  onAddExtraSet?(): void;
  onChooseNext(entry: ExerciseEntry): void;
  canAdvance: boolean;
  /** The dock's number row(s) and LOG. `keys` is rendered between them. */
  renderEditor(entry: ExerciseEntry, keys: ReactNode): ReactNode;
  formatScheme?(entry: ExerciseEntry): string;
  /**
   * Replaces the exercise name + set position with a superset round's own
   * identity ("Superset A" / "round 1 of 3").
   */
  supersetHeading?: { title: string; subtitle: string } | null;
  /** The picture of what is in front of the lifter: plates, dumbbells, a
   *  pin stack, bodyweight — or, for a superset, the A1/A2 cards. */
  picture?: ReactNode;
  /** The coach's cue for this exercise (prescription notes). */
  cue?: string | null;
  /** "Last time · 185 lb × 5" */
  lastTime?: string | null;
  /** While a rest runs, it takes the middle of the screen: the clock, the
   *  set that was just saved, and what to load next. */
  restSlot?: ReactNode;
  /** "NEXT SET · SET 4 OF 6" and End rest now, above the dock's numbers
   *  while resting — so it is plain the numbers belong to the NEXT set. */
  dockTag?: ReactNode;
  /** Set when the set being staged is a WARMUP of an entry that also has
   *  working sets: the position line then counts the warmups ("SET 1 OF 2 ·
   *  WARMUP") instead of the working sets. A warmup-only run needs no help:
   *  its own target already is the warmups. */
  warmupPosition?: { number: number; of: number } | null;
  /** "lb this session · Settings says kg", while one is overriding it. */
  unitNote?: string | null;
  /** The warmup | working choice, offered only where the plan has a warmup
   *  for this exercise; and "Already warm" beside it while a warmup is
   *  staged. */
  warmupChoice?: {
    staged: "warmup" | "working";
    onChange(next: "warmup" | "working"): void;
    onAlreadyWarm?(): void;
  } | null;
  keys: FocusKeys;
  /** Everything the default screen leaves out — the plan and coach notes,
   *  warmup/working, how-to, the plate calculator, the logged sets — behind
   *  one quiet control. */
  onOpenMore?(): void;
  /** Skip, with an optional reason collected inline. `onSkip` fires once,
   *  with the chosen chip text (or null for none). */
  onSkip?(reason: string | null): void;
  skipped?: boolean;
  /** why it was skipped, when the lifter said */
  skipReason?: string | null;
  onUnskip?(): void;
}

const SKIP_REASON_CHIPS = [
  "Equipment taken",
  "Already warm",
  "Out of time",
  "Didn't feel right",
];

/**
 * The four small keys: RPE, Note, Skip, and Swap-or-Fix-last. One component,
 * because the Focus dock and List's open card show the same keys with the
 * same states — a key that cannot do anything right now is DISABLED, never
 * hidden, so the row does not rearrange itself under a thumb.
 */
export function DockKeys({
  keys,
  skip,
}: {
  keys: FocusKeys;
  skip: { label: string; onPress(): void } | null;
}) {
  return (
    <div className="focus-keys">
      <button type="button" className="focus-key" onClick={keys.onRpe}>
        {keys.rpeValue != null ? `RPE ${keys.rpeValue}` : "RPE"}
      </button>
      <button
        type="button"
        className="focus-key"
        disabled={keys.onNote === null}
        onClick={keys.onNote ?? undefined}
      >
        Note
      </button>
      <button
        type="button"
        className="focus-key"
        disabled={skip === null}
        onClick={skip?.onPress}
      >
        {skip?.label ?? "Skip"}
      </button>
      <button
        type="button"
        className="focus-key"
        disabled={keys.fourth === null}
        onClick={keys.fourth?.onPress}
      >
        {keys.fourth?.label ?? "Fix last"}
      </button>
    </div>
  );
}

function focusSetPosition(
  entry: ExerciseEntry,
  entries: readonly ExerciseEntry[],
  entryProgress: FocusDeckProps["entryProgress"],
  supersetHeading: FocusDeckProps["supersetHeading"],
): { progress: number; target: number } {
  const progress = entryProgress(entry);
  const target = targetSets(entry);
  const pair = supersetHeading ? twoMemberSuperset(entries, entry.key) : null;
  if (pair !== null) {
    const [a1, a2] = pair;
    const progressA = entryProgress(a1);
    const progressB = entryProgress(a2);
    const targetA = targetSets(a1);
    const targetB = targetSets(a2);
    const exhaustedA = targetA > 0 && progressA >= targetA;
    const exhaustedB = targetB > 0 && progressB >= targetB;
    const tail = exhaustedA !== exhaustedB;

    return {
      progress: Math.min(progressA, progressB),
      target: tail ? Math.max(targetA, targetB) : Math.min(targetA, targetB),
    };
  }

  return { progress, target };
}

const SEGMENT_STATE: Record<"completed" | "current" | "future", ProgressState> =
  {
    completed: "done",
    current: "current",
    future: "upcoming",
  };

function FocusSetProgress({
  progress,
  target,
  warmup = false,
}: {
  progress: number;
  target: number;
  /** Every segment in THIS run is a warmup — the run itself is always one
   *  kind or the other (see lib/entries.ts's `targetSets`). */
  warmup?: boolean;
}) {
  // The previous render's completed count, so a log (progress going up) can
  // be told apart from a fresh mount or an unrelated re-render — only the
  // first plays a motion.
  const previousCompletedRef = useRef<number | null>(null);
  const previousCompleted = previousCompletedRef.current;
  useEffect(() => {
    previousCompletedRef.current = Math.min(Math.max(0, progress), target);
  });

  if (target <= 0) return null;

  const completed = Math.min(Math.max(0, progress), target);
  const justLogged =
    previousCompleted !== null && completed === previousCompleted + 1
      ? previousCompleted
      : null;

  return (
    <div className="focus-set-progress" aria-hidden="true">
      {Array.from({ length: target }, (_, index) => {
        const localState: "completed" | "current" | "future" =
          index < completed
            ? "completed"
            : index === completed
              ? "current"
              : "future";
        const state = SEGMENT_STATE[localState];
        const motion =
          justLogged === null
            ? ""
            : index === justLogged
              ? " motion-set-logged"
              : index === justLogged + 1
                ? " motion-set-entering"
                : "";
        return (
          <span
            key={index}
            className={`focus-set-segment focus-set-segment--${localState}${motion}`}
            data-state={state}
          >
            <StateGlyph
              state={state}
              warmup={warmup}
              label={`${warmup ? "warmup" : "set"} ${index + 1} — ${state}`}
            />
          </span>
        );
      })}
    </div>
  );
}

/** The speech-bubble mark for coach notes: ink, never the current-set ochre,
 *  so a cue never reads like a status. */
function CoachIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" className="focus-cue-icon">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 6.5h15v10h-8l-4.5 3.5v-3.5h-2.5z" />
        <path d="M9 10.5h6M9 13h4" />
      </g>
    </svg>
  );
}

/**
 * One exercise at a time, in three bands: what it is and where you are
 * (name, set position, segments); what is in front of you (the load picture,
 * the coach's cue, last time — or, while resting, the rest clock and what to
 * load next); and the dock, which holds the numbers being staged, four small
 * keys and LOG. It owns no draft or persistence state: Session supplies the
 * controlled editor and receives all navigation intent.
 *
 * The middle band is the one that scrolls. The status band and the dock keep
 * their height, so at 320 px wide or with large text the middle gives way and
 * scrolls ABOVE the dock — nothing in it can end up under the Log button.
 *
 * Session mounts this with `key={entry.key}`: the skip prompt and the segment
 * animation belong to ONE exercise, so a prompt opened on exercise A must not
 * still be open, with its chips bound to the new `entry`, on exercise B (M6).
 */
export function FocusDeck({
  entries,
  entry,
  entryProgress,
  entryDone,
  workoutComplete = false,
  extraSetArmed = false,
  onFinishWorkout,
  onAddExtraSet,
  onChooseNext,
  canAdvance,
  renderEditor,
  formatScheme,
  supersetHeading = null,
  picture,
  cue = null,
  lastTime = null,
  restSlot,
  dockTag,
  unitNote = null,
  warmupPosition = null,
  warmupChoice = null,
  keys,
  onOpenMore,
  onSkip,
  skipped = false,
  skipReason = null,
  onUnskip,
}: FocusDeckProps) {
  const [skipPromptOpen, setSkipPromptOpen] = useState(false);
  // The reasons open at the TOP of the middle band and take focus: appended
  // below the rest card they sat under the dock where nothing showed that
  // Skip had done anything (D1).
  const skipPromptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!skipPromptOpen) return;
    const prompt = skipPromptRef.current;
    if (!prompt) return;
    const scroller = prompt.closest(".focus-middle");
    if (scroller) scroller.scrollTop = 0;
    prompt.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [skipPromptOpen]);
  // Is there more in the middle band than shows above the dock? Then it fades
  // at the bottom edge and says so; with nothing hidden it is left alone.
  const middleRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useEffect(() => {
    const el = middleRef.current;
    if (!el) return;
    const measure = () =>
      setMoreBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 4);
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  });
  const entryIndex = entries.findIndex(
    (candidate) => candidate.key === entry.key,
  );
  const { progress, target } = focusSetPosition(
    entry,
    entries,
    entryProgress,
    supersetHeading,
  );
  const complete = entryDone(entry) && !skipped;
  const next = entryDone(entry)
    ? (entries
        .slice(entryIndex + 1)
        .find((candidate) => !entryDone(candidate)) ?? null)
    : null;
  const setPosition = warmupPosition
    ? `SET ${warmupPosition.number} OF ${warmupPosition.of}`
    : target === 0
      ? "SET BY FEEL"
      : `SET ${Math.min(progress + 1, target)} OF ${target}`;
  const warmupRun = warmupSets(entry) > 0 && workingSets(entry) === 0;
  const resting = restSlot !== undefined && restSlot !== null && restSlot !== false;
  const showNext =
    next !== null && canAdvance && !workoutComplete && !extraSetArmed;
  // A finished exercise (or the finished workout) keeps its editor out of the
  // way until the lifter asks for an extra set: the dock then leads with the
  // next exercise or Finish.
  const showEditor =
    !skipped && (!complete || extraSetArmed) && (!workoutComplete || extraSetArmed);

  const skipKey = skipped && onUnskip
    ? { label: "Unskip", onPress: onUnskip }
    : onSkip
      ? { label: "Skip", onPress: () => setSkipPromptOpen((open) => !open) }
      : null;

  const keyRow = <DockKeys keys={keys} skip={skipKey} />;

  return (
    <section className="focus-deck">
      <div className="focus-deck-status" aria-live="polite">
        <h1 className="focus-deck-name">
          {supersetHeading ? supersetHeading.title : entry.name}
        </h1>
        <div className="focus-deck-position-row">
          <div className="focus-deck-position">
            {supersetHeading
              ? supersetHeading.subtitle
              : skipped
                ? "SKIPPED"
                : setPosition}
            {(warmupRun || warmupPosition) && !supersetHeading && !skipped
              ? " · WARMUP"
              : ""}
          </div>
          {onOpenMore && (
            <button
              type="button"
              className="focus-deck-more"
              aria-label={`more options for ${entry.name}`}
              onClick={onOpenMore}
            >
              <span aria-hidden="true">•••</span>
            </button>
          )}
        </div>
        {/* Its own line: beside the position it squeezed "SET 1 OF 2 · WARMUP"
            into one word per row at 320 px. */}
        {unitNote && <div className="focus-unit-note">{unitNote}</div>}
        {(!skipped || supersetHeading) && (
          <FocusSetProgress progress={progress} target={target} warmup={warmupRun} />
        )}
      </div>

      <div className="focus-middle-wrap">
      <div
        className={`focus-middle${moreBelow ? " focus-middle--more" : ""}`}
        ref={middleRef}
      >
        {onSkip && !skipped && skipPromptOpen && (
          <div
            ref={skipPromptRef}
            className="skip-reason-prompt chip-row"
            role="group"
            aria-label="Skip reason"
          >
            {SKIP_REASON_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className="chip"
                onClick={() => {
                  onSkip(chip);
                  setSkipPromptOpen(false);
                }}
              >
                {chip}
              </button>
            ))}
            <button
              type="button"
              className="chip"
              onClick={() => {
                onSkip(null);
                setSkipPromptOpen(false);
              }}
            >
              No reason
            </button>
            <button
              type="button"
              className="chip chip-quiet"
              onClick={() => setSkipPromptOpen(false)}
            >
              Cancel
            </button>
          </div>
        )}
        {skipped && (
          <p className="focus-skipped">
            Skipped{skipReason ? ` · ${skipReason}` : ""}.
          </p>
        )}
        {resting
          ? restSlot
          : !workoutComplete && !complete && (!skipped || supersetHeading) && picture}
        {/* Outside the rest branch: a rest often runs after the final set,
            and "+ Extra set" must stay reachable while it does. */}
        {(workoutComplete || complete) && !extraSetArmed && (
          <div className="focus-complete">
            <div className="focus-complete-title">
              {workoutComplete
                ? "All planned sets logged."
                : `${entry.name}: all planned sets logged.`}
            </div>
            {onAddExtraSet && (
              <button type="button" className="focus-chip-btn" onClick={onAddExtraSet}>
                + Extra set
              </button>
            )}
          </div>
        )}
        {warmupChoice && !skipped && !complete && (
          <div className="focus-type-row">
            <div className="seg seg-types" role="group" aria-label="Set type">
              {(["warmup", "working"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`seg-btn ${warmupChoice.staged === t ? "seg-on" : ""}`}
                  aria-pressed={warmupChoice.staged === t}
                  onClick={() => warmupChoice.onChange(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            {warmupChoice.staged === "warmup" && warmupChoice.onAlreadyWarm && (
              <button
                type="button"
                className="text-link focus-already-warm"
                onClick={warmupChoice.onAlreadyWarm}
              >
                Already warm
              </button>
            )}
          </div>
        )}
        {!resting && cue && !skipped && !complete && (
          <div className="focus-cue">
            <CoachIcon />
            <span>
              <b>Coach</b> · {cue}
            </span>
          </div>
        )}
        {!resting && !workoutComplete && !complete && !skipped && lastTime && (
          <p className="focus-last-performance">{lastTime}</p>
        )}
      </div>
      {moreBelow && (
        <span className="focus-more-cue" aria-hidden="true">
          ▾ MORE
        </span>
      )}
      </div>

      <div className="focus-dock">
        {dockTag}
        {showNext && next && (
          <button
            type="button"
            className="focus-next"
            aria-label={`Next exercise: ${next.name}`}
            onClick={() => onChooseNext(next)}
          >
            <span className="focus-next-eyebrow">NEXT EXERCISE →</span>
            <span className="focus-next-name">{next.name}</span>
            {formatScheme && (
              <span className="focus-next-scheme">{formatScheme(next)}</span>
            )}
          </button>
        )}
        {workoutComplete && !extraSetArmed && onFinishWorkout && (
          <button
            type="button"
            className="btn btn-primary btn-block focus-finish"
            onClick={onFinishWorkout}
          >
            Finish session
          </button>
        )}
        {skipped && onUnskip && (
          // A skipped entry counts as done, so the editor is not rendered —
          // the "Unskip to log it" line in the middle band needs something to
          // press.
          <button
            type="button"
            className="btn btn-outline-ink btn-block focus-unskip"
            onClick={onUnskip}
          >
            Unskip
          </button>
        )}
        {!showEditor && !skipped && keys.fourth !== null && (
          // A finished exercise has no next set to stage, but its last set is
          // still the one to annotate or fix: those two keys stay reachable.
          <div className="focus-keys focus-keys-done">
            <button
              type="button"
              className="focus-key"
              disabled={keys.onNote === null}
              onClick={keys.onNote ?? undefined}
            >
              Note
            </button>
            <button type="button" className="focus-key" onClick={keys.fourth.onPress}>
              {keys.fourth.label}
            </button>
          </div>
        )}
        {showEditor && renderEditor(entry, keyRow)}
      </div>
    </section>
  );
}
