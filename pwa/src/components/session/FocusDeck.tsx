import type { ReactNode } from "react";
import { targetSets, type ExerciseEntry } from "../../lib/entries";

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
}: FocusDeckProps) {
  const entryIndex = entries.findIndex(
    (candidate) => candidate.key === entry.key,
  );
  const progress = entryProgress(entry);
  const target = targetSets(entry);
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
          onClick={onViewFullWorkout}
        >
          View full workout
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
        <h1 className="focus-deck-name">{entry.name}</h1>
        <div className="focus-deck-position">{setPosition}</div>
      </div>

      <div className="focus-deck-editor">{renderEditor(entry)}</div>

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
