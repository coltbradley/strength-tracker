// One logged set line: index, load × reps, type, optional rest column.
// Used by Session (with rest) and History (without).

import { toDisplay, type Unit } from "../lib/units";
import type { SetInsert } from "../lib/types";

interface SetRowProps {
  set: SetInsert;
  unit: Unit;
  /** rest AFTER this set ("rest 2:38"); pass undefined to omit the column */
  restLabel?: string | null;
}

export function SetRow({ set, unit, restLabel }: SetRowProps) {
  return (
    <div
      className={`logged-set ${restLabel !== undefined ? "logged-set-rest" : ""}`}
    >
      <span className="set-no">{set.set_index + 1}</span>
      <span className="set-load">
        {toDisplay(set.load_kg, unit)} × {set.reps}
      </span>
      <span
        className={`set-type ${set.set_type !== "working" ? "set-type-accent" : ""}`}
      >
        {set.set_type}
      </span>
      {restLabel !== undefined && (
        <span className="set-rest">{restLabel ?? ""}</span>
      )}
    </div>
  );
}
