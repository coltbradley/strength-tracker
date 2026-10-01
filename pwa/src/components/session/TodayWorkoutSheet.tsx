// "Today's workout": the one overview that works from both Focus and List.
// It is where the unit for THIS session changes, where any exercise is one
// tap away, where today's order is rearranged (drag, arrow keys, or visible
// Move up / Move down), and where Finish lives. Rows come from the same
// entryState / entryProgress the list and the focus deck use, so the three
// surfaces cannot disagree.
//
// Order is session-local presentation: the sheet reports a move and Session
// applies it through lib/sessionOrder.ts, whose block rules decide what may
// move. The plan and every recorded set index are untouched.

import { Sheet } from "../Sheet";
import { ReorderList, type ReorderItem } from "./ReorderList";
import { UnitSwitch } from "./UnitSwitch";
import { targetSets, type ExerciseEntry, type SupersetTag } from "../../lib/entries";
import type { Unit } from "../../lib/units";
import type { ProgressState } from "./StateGlyph";

export interface WorkoutReceiptMark {
  glyph: string;
  label: string;
}

export interface TodayWorkoutSheetProps {
  /** the movable units in today's order: each is a whole block */
  blocks: readonly (readonly ExerciseEntry[])[];
  unit: Unit;
  /** the device default, so the sheet can say what "Settings keeps" */
  deviceUnit: Unit;
  onUnitChange(next: Unit): void;
  unitDisabled?: boolean;
  entryProgress(entry: ExerciseEntry): number;
  entryState(entry: ExerciseEntry): ProgressState;
  formatScheme(entry: ExerciseEntry): string;
  /** a quiet roll-up of the exercise's per-set receipts, or null */
  receiptMark?(entries: readonly ExerciseEntry[]): WorkoutReceiptMark | null;
  /** Tapping a row. The caller decides what "go to it" means in the current
   *  presentation; the sheet closes itself afterwards. */
  onSelect(entry: ExerciseEntry): void;
  /** A correction pins the screen to its own exercise: any member of the
   *  unit being locked locks the whole row. */
  isLocked?(entry: ExerciseEntry): boolean;
  /** Move the block at `fromBlock` to `toBlock`; false when the order rules
   *  refuse (it would split a section or superset). */
  onMoveBlock(fromBlock: number, toBlock: number): boolean;
  /** Whether a one-place move is legal right now, per block. */
  canMoveBlock(blockIndex: number, direction: "up" | "down"): boolean;
  /** True while a write is in flight or a correction is open. */
  reorderLocked?: boolean;
  hasSections?: boolean;
  supersetInfo?: ReadonlyMap<string, SupersetTag>;
  selectedKey?: string | null;
  /** "Add exercise" and "Back to Train" are reachable from here because Focus
   *  has no footer: without them the only way out of Focus was List. */
  onAddExercise?(): void;
  onHome?(): void;
  onFinish(): void;
  onClose(): void;
}

export function TodayWorkoutSheet({
  blocks,
  unit,
  deviceUnit,
  onUnitChange,
  unitDisabled = false,
  entryProgress,
  entryState,
  formatScheme,
  receiptMark,
  onSelect,
  isLocked = () => false,
  onMoveBlock,
  canMoveBlock,
  reorderLocked = false,
  hasSections = false,
  supersetInfo = new Map(),
  selectedKey = null,
  onAddExercise,
  onHome,
  onFinish,
  onClose,
}: TodayWorkoutSheetProps) {
  const sectionOf = (e: ExerciseEntry | undefined) =>
    e?.brackets[0]?.section ?? null;
  let previousSection: string | null | undefined;
  const items: ReorderItem[] = blocks.map((members, index) => {
    const section = sectionOf(members[0]);
    const heading =
      previousSection !== section
        ? (section ?? (hasSections ? "Main work" : undefined))
        : undefined;
    previousSection = section;
    const done = members.reduce((n, e) => n + entryProgress(e), 0);
    const total = members.reduce(
      (n, e) => n + (e.brackets.length > 0 ? targetSets(e) : 0),
      0,
    );
    return {
      key: members[0].key,
      lines: members.map((e) => {
        const tag = supersetInfo.get(e.key)?.tag;
        return {
          key: e.key,
          title: tag ? `${tag} · ${e.name}` : e.name,
          subtitle:
            e.brackets.length > 0 ? formatScheme(e).toUpperCase() : "BY FEEL",
          state: entryState(e),
          locked: isLocked(e),
        };
      }),
      meta: total > 0 ? `${done}/${total}` : `${done}`,
      receipt: receiptMark?.(members) ?? undefined,
      heading,
      canMoveUp: canMoveBlock(index, "up"),
      canMoveDown: canMoveBlock(index, "down"),
    };
  });

  const reorderable = blocks.length > 1;
  return (
    <Sheet title="Today's workout" onClose={onClose}>
      <div className="tw-units">
        <span className="tw-units-label">
          <b>Units this session</b>
          <span className="microcopy">
            {unit === deviceUnit
              ? "Settings keeps your default"
              : `Settings says ${deviceUnit}. Only this workout shows ${unit}.`}
          </span>
        </span>
        <UnitSwitch unit={unit} onChange={onUnitChange} disabled={unitDisabled} />
      </div>

      <p className="microcopy">
        {reorderable
          ? "Tap to jump. Drag ⠿, or use Move up and Move down, to change today’s order. The plan stays the same."
          : "Tap an exercise to jump to it."}
      </p>
      {reorderLocked && reorderable && (
        <p className="microcopy tw-locked" role="status">
          Order is locked while a set is being saved or corrected.
        </p>
      )}

      <ReorderList
        items={items}
        disabled={reorderLocked || !reorderable}
        selectedKey={selectedKey}
        onMove={onMoveBlock}
        onSelect={(entryKey) => {
          const entry = blocks.flat().find((candidate) => candidate.key === entryKey);
          if (!entry || isLocked(entry)) return;
          onSelect(entry);
          onClose();
        }}
      />

      {onAddExercise && (
        <button type="button" className="btn btn-ghost btn-block" onClick={onAddExercise}>
          + Add exercise
        </button>
      )}
      {onHome && (
        <button type="button" className="btn btn-ghost btn-block" onClick={onHome}>
          Back to Train (the session keeps running)
        </button>
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
