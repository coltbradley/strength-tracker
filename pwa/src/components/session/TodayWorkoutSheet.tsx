// "Today's workout": the one overview that works from both Focus and List.
// It is where the unit for this session changes (so the list-mode heading no
// longer carries its own switch), where any exercise is one tap away, and
// where Finish lives. Rows come from the same entryState / entryProgress the
// list and the focus deck use, so the three surfaces cannot disagree.

import type { ReactNode } from "react";
import { Sheet } from "../Sheet";
import { ReorderList, type ReorderItem } from "./ReorderList";
import { StateGlyph, type ProgressState } from "./StateGlyph";
import { UnitSwitch } from "./UnitSwitch";
import { targetSets, type ExerciseEntry, type SupersetTag } from "../../lib/entries";
import { entryUnits } from "../../lib/entryOrder";
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
  /** Move one UNIT (a lone exercise or a whole superset) from one place in
   *  today's order to another; indices are into `entryUnits(entries)`.
   *  Session-local presentation order only, never the plan. When given, the
   *  rows become a drag-to-reorder list. */
  onMoveUnit?(fromUnit: number, toUnit: number): void;
  hasSections?: boolean;
  supersetInfo?: ReadonlyMap<string, SupersetTag>;
  selectedKey?: string | null;
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
  onMoveUnit,
  hasSections = false,
  supersetInfo = new Map(),
  selectedKey = null,
  onFinish,
  onClose,
}: TodayWorkoutSheetProps) {
  const reorderable = onMoveUnit !== undefined && entries.length > 1;
  return (
    <Sheet title="Today's workout" onClose={onClose}>
      <div className="tw-units">
        <span className="tw-units-label">
          <b>Units this session</b>
          <span className="microcopy">Changes every weight shown</span>
        </span>
        <UnitSwitch unit={unit} onChange={onUnitChange} />
      </div>

      {reorderable ? (
        <>
          <p className="microcopy">
            Tap to jump. Drag ⠿ to change today’s order — the plan stays the
            same.
          </p>
          <ReorderList
            items={reorderItems(
              entries,
              supersetInfo,
              hasSections,
              formatScheme,
              entryProgress,
              entryState,
            )}
            selectedKey={selectedKey}
            onMove={onMoveUnit!}
            onSelect={(key) => {
              const entry = entries.find((e) => e.key === key);
              if (!entry || isLocked(entry)) return;
              onSelect(entry);
              onClose();
            }}
          />
        </>
      ) : (
      <>
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
      </>
      )}

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

/** One reorder row per unit, headed by the same run-level section label the
 *  overview prints (a section may honestly appear twice after a move). */
export function reorderItems(
  entries: readonly ExerciseEntry[],
  supersetInfo: ReadonlyMap<string, SupersetTag>,
  hasSections: boolean,
  formatScheme: (entry: ExerciseEntry) => string,
  entryProgress: (entry: ExerciseEntry) => number,
  entryState?: (entry: ExerciseEntry) => ProgressState,
): ReorderItem[] {
  const sectionOf = (e: ExerciseEntry | undefined) =>
    e?.brackets[0]?.section ?? null;
  let previous: string | null | undefined;
  return entryUnits(entries).map((unit) => {
    const first = unit[0];
    const section = sectionOf(first);
    const heading =
      previous !== section
        ? (section ?? (hasSections ? "Main work" : undefined))
        : undefined;
    previous = section;
    const done = unit.reduce((n, e) => n + entryProgress(e), 0);
    const total = unit.reduce(
      (n, e) => n + (e.brackets.length > 0 ? targetSets(e) : 0),
      0,
    );
    const states = entryState ? unit.map(entryState) : [];
    const state =
      states.find((s) => s === "current") ??
      (states.length > 0 && states.every((s) => s === "done")
        ? "done"
        : states.length > 0 && states.every((s) => s === "skipped")
          ? "skipped"
          : states.find((s) => s === "next")) ??
      states[0];
    return {
      key: first.key,
      title: unit
        .map((e) => {
          const tag = supersetInfo.get(e.key)?.tag;
          return tag ? `${tag} ${e.name}` : e.name;
        })
        .join(" · "),
      subtitle: unit
        .map((e) =>
          e.brackets.length > 0 ? formatScheme(e).toUpperCase() : "BY FEEL",
        )
        .join(" · "),
      meta: total > 0 ? `${done}/${total}` : `${done}`,
      state,
      heading,
    };
  });
}
