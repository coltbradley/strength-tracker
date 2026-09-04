// One logged set line: index, load × reps, type, optional rest column, and
// an optional void control (append-only correction — the set is hidden, not
// edited). Used by Session (with rest + void + correct) and History (plain).
//
// The numbers themselves are the tap target for a CORRECTION when `onEdit` is
// given: the row is what was lifted, so tapping it is how you say "not that".
// A correction is still a void plus a new row underneath (lib/corrections.ts);
// this component only knows it is the set being corrected, so it can say so.
//
// The control SAYS "remove" and the code says "void" on purpose. "Void" is the
// honest domain word — the row survives in Postgres and an insert into
// set_voids hides it from every view — and it stays the name of the table, the
// prop and the cache family. But it is jargon at the exact moment a person is
// least sure what is about to happen: the confirm tap. What she needs to know
// there is that the set leaves her history, which is what "remove" says.

import { enteredKg } from "../lib/loadEntry";
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
  /** when provided, tapping the numbers starts a correction of this set */
  onEdit?: () => void;
  /** this set is the one currently being corrected */
  editing?: boolean;
}

export function SetRow({
  set,
  unit,
  restLabel,
  onVoid,
  voidArmed = false,
  onArmVoid,
  onEdit,
  editing = false,
}: SetRowProps) {
  const numbers = (
    <>
      {toDisplay(enteredKg(set.load_kg, set.load_entry ?? "total"), unit)}{" "}
      {unit}
      {set.load_entry === "per_side" ? "/side" : ""} × {set.reps}
    </>
  );
  return (
    <div
      className={`logged-set ${restLabel !== undefined ? "logged-set-rest" : ""} ${onVoid ? "logged-set-voidable" : ""} ${editing ? "logged-set-editing" : ""}`}
    >
      <span className="set-no">{set.set_index + 1}</span>
      {/* the unit is not optional: "100 × 5" is a different set in kg and
          in lb, and this row is the record of what was actually lifted.
          load_kg is always the TOTAL, so a set entered per side is shown
          back the way it was entered — "30 kg/side × 8", never the 60 the
          column holds. A null load_entry is not an assertion of "total",
          but it is also not a per-side claim, so it renders plainly. */}
      {onEdit ? (
        <button
          type="button"
          className="set-load set-load-editable"
          aria-label={`correct set ${set.set_index + 1}`}
          aria-pressed={editing}
          onClick={onEdit}
        >
          {numbers}
        </button>
      ) : (
        <span className="set-load">{numbers}</span>
      )}
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
          aria-label={voidArmed ? "confirm remove set" : "remove set"}
          onClick={() => (voidArmed ? onVoid() : onArmVoid?.())}
        >
          {voidArmed ? "REMOVE?" : "✕"}
        </button>
      )}
    </div>
  );
}
