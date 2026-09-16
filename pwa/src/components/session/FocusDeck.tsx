import { useState, type ReactNode } from "react";
import {
  targetSets,
  warmupSets,
  workingSets,
  type ExerciseEntry,
} from "../../lib/entries";
import { twoMemberSuperset } from "../../lib/sessionFocus";
import { StateGlyph, type ProgressState } from "./StateGlyph";

export interface FocusDeckProps {
  entries: readonly ExerciseEntry[];
  entry: ExerciseEntry;
  entryProgress(entry: ExerciseEntry): number;
  entryDone(entry: ExerciseEntry): boolean;
  /** One state per entry, from the shared vocabulary — see StateGlyph.tsx
   *  and lib/sessionFocus.ts's `railState`. Drives both the progress rail
   *  below and, from the identical source, WorkoutOverview's rows. */
  entryState(entry: ExerciseEntry): ProgressState;
  onViewFullWorkout(): void;
  onChooseNext(entry: ExerciseEntry): void;
  canAdvance: boolean;
  renderEditor(entry: ExerciseEntry): ReactNode;
  /**
   * One quiet control for everything the default screen deliberately does
   * not show: RPE, a set note, warmup/working, skip, the plate calculator,
   * correcting or voiding a logged set, last time, and the full logged-set
   * history. Nothing on the default screen is a second copy of any of it —
   * this is the only door to all of it. Optional only so a caller mid-render
   * can omit it; Session always supplies one.
   */
  onOpenMore?(): void;
  /** Same formatter `WorkoutOverview` uses for a TARGET line, reused so the
   *  quiet "next" line names a scheme in the one convention the app has. */
  formatScheme?(entry: ExerciseEntry): string;
  /**
   * Replaces the exercise name + set position with a superset round's own
   * identity ("Superset A" / "round 1 of 3") while a live round is showing
   * two member blocks below — naming the exercise twice on one screen is
   * exactly what a superset's compact members already do. Null (the default)
   * keeps the ordinary single-exercise header.
   */
  supersetHeading?: { title: string; subtitle: string } | null;
  /** Visible only when a swap is offered right now (not mid-correction, not
   *  frozen by a logged set against it — Session decides and omits both
   *  props otherwise). Scoped to the canonical first member for a live
   *  superset round, matching `onOpenMore`'s existing scope. */
  onSwap?(): void;
  swapLabel?: string | null;
  /** Skip, with an optional reason collected inline. `onSkip` fires once,
   *  with the chosen chip text or free-typed reason (or null for none). */
  onSkip?(reason: string | null): void;
  skipped?: boolean;
  onUnskip?(): void;
}

const SKIP_REASON_CHIPS = [
  "Equipment taken",
  "Already warm",
  "Out of time",
  "Didn't feel right",
];

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
  /** Every dot in THIS run is a warmup — the run itself is always one kind
   *  or the other (see lib/entries.ts's `targetSets`), never mixed, so one
   *  flag for the whole strip is enough. */
  warmup?: boolean;
}) {
  if (target <= 0) return null;

  const completed = Math.min(Math.max(0, progress), target);
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
        return (
          <span
            key={index}
            className={`focus-set-segment focus-set-segment--${localState}`}
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

/**
 * A narrow presentation of the same session state that powers the overview.
 * It owns no draft or persistence state: Session supplies the controlled
 * editor and receives all navigation intent.
 *
 * Deliberately spare: the load (or reps, for bodyweight) and LOG are the only
 * things on screen with visual weight. Everything else the accordion shows
 * inline lives one tap away, behind `onOpenMore` — see its own doc comment.
 */
export function FocusDeck({
  entries,
  entry,
  entryProgress,
  entryDone,
  entryState,
  onViewFullWorkout,
  onChooseNext,
  canAdvance,
  renderEditor,
  onOpenMore,
  formatScheme,
  supersetHeading = null,
  onSwap,
  swapLabel = null,
  onSkip,
  skipped = false,
  onUnskip,
}: FocusDeckProps) {
  const [skipPromptOpen, setSkipPromptOpen] = useState(false);
  const [skipReasonDraft, setSkipReasonDraft] = useState("");
  const entryIndex = entries.findIndex(
    (candidate) => candidate.key === entry.key,
  );
  const { progress, target } = focusSetPosition(
    entry,
    entries,
    entryProgress,
    supersetHeading,
  );
  const complete = entryDone(entry);
  const next = complete
    ? (entries
        .slice(entryIndex + 1)
        .find((candidate) => !entryDone(candidate)) ?? null)
    : null;
  const setPosition =
    target === 0
      ? "SET BY FEEL"
      : `SET ${Math.min(progress + 1, target)} OF ${target}`;

  return (
    <section className="focus-deck">
      <div className="focus-deck-top">
        {/* A real <ul>, not a <div role="list">: the dots inside stay real
         * <button>s (role="listitem" on the button itself would REPLACE its
         * native button role, not add to it, so a screen reader would
         * announce a plain list item with no indication it is activatable —
         * that was shipped once and is exactly the regression this markup
         * avoids). role="list" is still explicit here because this list's
         * `list-style: none` strips the <ul>'s implicit list role in
         * Safari/VoiceOver (a known WebKit quirk) — do not remove it as
         * "redundant". */}
        <ul
          className="focus-progress-rail"
          role="list"
          aria-label="workout progress"
        >
          {entries.map((candidate) => {
            const state = entryState(candidate);
            const label = `${candidate.name} — ${state}`;
            return (
              <li key={candidate.key} className="focus-progress-dot-item">
                <button
                  type="button"
                  className="focus-progress-dot"
                  aria-label={
                    state === "current"
                      ? `${label} — view full workout`
                      : `${label} — jump here`
                  }
                  onClick={() =>
                    state === "current"
                      ? onViewFullWorkout()
                      : onChooseNext(candidate)
                  }
                >
                  <StateGlyph
                    state={state}
                    warmup={
                      warmupSets(candidate) > 0 && workingSets(candidate) === 0
                    }
                    label={label}
                  />
                </button>
              </li>
            );
          })}
        </ul>
        {onOpenMore && (
          <button
            type="button"
            className="focus-deck-more"
            aria-label={`more options for ${entry.name}`}
            onClick={onOpenMore}
          >
            •••
          </button>
        )}
      </div>

      <div className="focus-deck-status" aria-live="polite">
        <h1 className="focus-deck-name">
          {supersetHeading ? supersetHeading.title : entry.name}
        </h1>
        <div className="focus-deck-position">
          {supersetHeading ? supersetHeading.subtitle : setPosition}
        </div>
      </div>

      {(swapLabel !== null || onSkip || (skipped && onUnskip)) && (
        <div className="focus-deck-secondary-row">
          {onSwap && swapLabel !== null && (
            <button
              type="button"
              className="focus-deck-secondary"
              onClick={onSwap}
            >
              {swapLabel}
            </button>
          )}
          {onSkip && !skipped && !skipPromptOpen && (
            <button
              type="button"
              className="focus-deck-secondary"
              onClick={() => setSkipPromptOpen(true)}
            >
              Skip
            </button>
          )}
          {skipped && onUnskip && (
            <button
              type="button"
              className="focus-deck-secondary"
              onClick={onUnskip}
            >
              Unskip
            </button>
          )}
        </div>
      )}

      {onSkip && !skipped && skipPromptOpen && (
        <div className="skip-reason-prompt">
          <div className="chip-row">
            {SKIP_REASON_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className="chip"
                onClick={() => {
                  onSkip(chip);
                  setSkipPromptOpen(false);
                  setSkipReasonDraft("");
                }}
              >
                {chip}
              </button>
            ))}
          </div>
          <input
            className="input skip-reason-input"
            placeholder="Reason (optional)"
            value={skipReasonDraft}
            onChange={(e) => setSkipReasonDraft(e.target.value)}
          />
          <div className="skip-reason-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setSkipPromptOpen(false);
                setSkipReasonDraft("");
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                onSkip(
                  skipReasonDraft.trim() === "" ? null : skipReasonDraft.trim(),
                );
                setSkipPromptOpen(false);
                setSkipReasonDraft("");
              }}
            >
              Skip exercise
            </button>
          </div>
        </div>
      )}

      <div className="focus-deck-editor">
        <FocusSetProgress
          progress={progress}
          target={target}
          warmup={warmupSets(entry) > 0 && workingSets(entry) === 0}
        />
        {renderEditor(entry)}
      </div>

      {next && canAdvance && (
        <button
          type="button"
          className="focus-next"
          aria-label="Next exercise"
          onClick={() => onChooseNext(next)}
        >
          next · {next.name}
          {formatScheme ? ` · ${formatScheme(next)}` : ""}
        </button>
      )}
    </section>
  );
}
