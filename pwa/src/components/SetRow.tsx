// One logged set line: "#n  load × reps  type". Used by Session and History.

import { toDisplay, type Unit } from "../lib/units";
import type { SetInsert } from "../lib/types";

export function SetRow({ set, unit }: { set: SetInsert; unit: Unit }) {
  return (
    <div className="logged-set">
      <span className="muted">#{set.set_index + 1}</span>
      <span>
        {toDisplay(set.load_kg, unit)} {unit} × {set.reps}
      </span>
      <span className="muted">{set.set_type}</span>
    </div>
  );
}
