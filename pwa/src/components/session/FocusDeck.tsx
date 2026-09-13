import type { ReactNode } from "react";
import { targetSets, type ExerciseEntry } from "../../lib/entries";
import { twoMemberSuperset } from "../../lib/sessionFocus";

export interface FocusDeckProps {
  entries: readonly ExerciseEntry[];
  entry: ExerciseEntry;
  entryProgress(entry: ExerciseEntry): number;
  entryDone(entry: ExerciseEntry): boolean;
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

function FocusSetProgress({
  progress,
  target,
}: {
  progress: number;
  target: number;
}) {
  if (target <= 0) return null;

  const completed = Math.min(Math.max(0, progress), target);
  return (
    <div className="focus-set-progress" aria-hidden="true">
      {Array.from({ length: target }, (_, index) => {
        const state =
          index < completed
            ? "completed"
            : index === completed
              ? "current"
              : "future";
        return (
          <span
            key={index}
            className={`focus-set-segment focus-set-segment--${state}`}
            data-state={state}
          >
            {state === "completed" ? "✓" : state === "current" ? "●" : ""}
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
  onViewFullWorkout,
  onChooseNext,
  canAdvance,
  renderEditor,
  onOpenMore,
  formatScheme,
  supersetHeading = null,
}: FocusDeckProps) {
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
        <button
          type="button"
          className="focus-deck-overview"
          aria-label="View full workout"
          onClick={onViewFullWorkout}
        >
          ≡
        </button>
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

      <div className="focus-deck-editor">
        <FocusSetProgress progress={progress} target={target} />
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
