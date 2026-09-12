import type { ReactNode } from "react";
import { remainingProgress } from "../../lib/sessionFocus";
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
}

/**
 * A narrow presentation of the same session state that powers the overview.
 * It owns no draft or persistence state: Session supplies the controlled
 * editor and receives all navigation intent.
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
}: FocusDeckProps) {
  const entryIndex = entries.findIndex((candidate) => candidate.key === entry.key);
  const progress = entryProgress(entry);
  const target = targetSets(entry);
  const complete = entryDone(entry);
  const next = complete
    ? entries
        .slice(entryIndex + 1)
        .find((candidate) => !entryDone(candidate)) ?? null
    : null;
  const { setsRemaining, exercisesRemaining } = remainingProgress(
    entries,
    entryDone,
    entryProgress,
  );
  const setPosition =
    target === 0
      ? "SET BY FEEL"
      : `SET ${Math.min(progress + 1, target)} OF ${target}`;

  return (
    <section className="focus-deck">
      <button
        type="button"
        className="focus-deck-overview"
        onClick={onViewFullWorkout}
      >
        View full workout
      </button>

      <div className="focus-deck-status" aria-live="polite">
        <div className="focus-deck-position">
          <span>EXERCISE {entryIndex + 1} OF {entries.length}</span>
          <span>{setPosition}</span>
        </div>
        <h1 className="focus-deck-name">{entry.name}</h1>
        <div className="focus-deck-remaining">
          <span>SETS REMAINING {setsRemaining}</span>
          <span>EXERCISES REMAINING {exercisesRemaining}</span>
        </div>
      </div>

      <div className="focus-deck-editor">{renderEditor(entry)}</div>

      {next && canAdvance && (
        <button
          type="button"
          className="btn btn-outline-ink btn-block"
          aria-label="Next exercise"
          onClick={() => onChooseNext(next)}
        >
          Next exercise · {next.name}
        </button>
      )}
    </section>
  );
}
