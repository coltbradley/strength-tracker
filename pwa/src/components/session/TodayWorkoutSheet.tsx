// "Today's workout": the one overview that works from both Focus and List.
// It is where the unit for this session changes (so the list-mode heading no
// longer carries its own switch), where any exercise is one tap away, and
// where Finish lives. Rows come from the same entryState / entryProgress the
// list and the focus deck use, so the three surfaces cannot disagree.

import type { ReactNode } from "react";
import { Sheet } from "../Sheet";
import { StateGlyph, type ProgressState } from "./StateGlyph";
import { UnitSwitch } from "./UnitSwitch";
import { targetSets, type ExerciseEntry } from "../../lib/entries";
import type { Unit } from "../../lib/units";

export interface TodayWorkoutSheetProps {
  entries: readonly ExerciseEntry[];
  unit: Unit;
  onUnitChange(next: Unit): void;
  entryProgress(entry: ExerciseEntry): number;
  entryState(entry: ExerciseEntry): ProgressState;
  isSkipped(entry: ExerciseEntry): boolean;
  formatScheme(entry: ExerciseEntry): string;
  /** Tapping a row. The caller decides what "go to it" means in the current
   *  presentation; the sheet closes itself afterwards. */
  onSelect(entry: ExerciseEntry): void;
  /** Rows that cannot be jumped to right now (a correction pins the screen to
   *  its own exercise). */
  isLocked?(entry: ExerciseEntry): boolean;
  /** The drag handle for reordering today's order, rendered at the start of
   *  each row. Reorder is built separately; until then this is empty and the
   *  row simply has no handle. */
  renderRowHandle?(entry: ExerciseEntry): ReactNode;
  onFinish(): void;
  onClose(): void;
}

export function TodayWorkoutSheet({
  entries,
  unit,
  onUnitChange,
  entryProgress,
  entryState,
  isSkipped,
  formatScheme,
  onSelect,
  isLocked = () => false,
  renderRowHandle,
  onFinish,
  onClose,
}: TodayWorkoutSheetProps) {
  return (
    <Sheet title="Today's workout" onClose={onClose}>
      <div className="tw-units">
        <span className="tw-units-label">
          <b>Units this session</b>
          <span className="microcopy">Changes every weight shown</span>
        </span>
        <UnitSwitch unit={unit} onChange={onUnitChange} />
      </div>

      <p className="microcopy">Tap an exercise to jump to it.</p>

      <ul className="tw-list">
        {entries.map((entry) => {
          const prescribed = entry.brackets.length > 0;
          const done = entryProgress(entry);
          const total = prescribed ? targetSets(entry) : null;
          const state = entryState(entry);
          const skipped = isSkipped(entry);
          const locked = isLocked(entry);
          return (
            <li key={entry.key} className="tw-row" data-state={state}>
              {renderRowHandle?.(entry)}
              <button
                type="button"
                className="tw-main"
                disabled={locked}
                aria-label={`${entry.name} — ${state}`}
                onClick={() => {
                  onSelect(entry);
                  onClose();
                }}
              >
                <StateGlyph state={state} label={`${entry.name} — ${state}`} />
                <span className={`tw-name ${skipped ? "tw-name-skipped" : ""}`}>
                  {entry.name}
                </span>
                <span className="tw-scheme">
                  {skipped
                    ? "SKIPPED"
                    : prescribed
                      ? formatScheme(entry).toUpperCase()
                      : "NO TARGET · BY FEEL"}
                </span>
                <span
                  className={`tw-count ${total !== null && done >= total ? "tw-count-done" : ""}`}
                >
                  {done}
                  {total !== null ? `/${total}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="btn btn-outline-ink btn-block"
        onClick={() => {
          onClose();
          onFinish();
        }}
      >
        Finish session
      </button>
    </Sheet>
  );
}
