// One logged set line: index, load × reps, type, optional rest column, and
// an optional void control (append-only correction — the set is hidden, not
// edited). Used by Session (with rest + void) and History (plain).

import { toDisplay, type Unit } from "../lib/units";
import type { SetInsert } from "../lib/types";

interface SetRowProps {
  set: SetInsert;
  unit: Unit;
  /** rest AFTER this set ("rest 2:38"); pass undefined to omit the column */
  restLabel?: string | null;
  /** when provided, renders a two-tap void control */
  onVoid?: () => void;
  /** first tap arms; the second tap (armed=true) voids */
  voidArmed?: boolean;
  onArmVoid?: () => void;
}

export function SetRow({
  set,
  unit,
  restLabel,
  onVoid,
  voidArmed = false,
  onArmVoid,
}: SetRowProps) {
  return (
    <div
      className={`logged-set ${restLabel !== undefined ? "logged-set-rest" : ""} ${onVoid ? "logged-set-voidable" : ""}`}
    >
      <span className="set-no">{set.set_index + 1}</span>
      {/* the unit is not optional: "100 × 5" is a different set in kg and
          in lb, and this row is the record of what was actually lifted */}
      <span className="set-load">
        {toDisplay(set.load_kg, unit)} {unit} × {set.reps}
      </span>
      <span
        className={`set-type ${set.set_type !== "working" ? "set-type-accent" : ""}`}
      >
        {set.set_type}
      </span>
      {restLabel !== undefined && (
        <span className="set-rest">{restLabel ?? ""}</span>
      )}
      {onVoid && (
        <button
          type="button"
          className={`set-void ${voidArmed ? "set-void-armed" : ""}`}
          aria-label={voidArmed ? "confirm void set" : "void set"}
          onClick={() => (voidArmed ? onVoid() : onArmVoid?.())}
        >
          {voidArmed ? "VOID?" : "✕"}
        </button>
      )}
    </div>
  );
}
