// Plate calculator sheet: what to put on the bar for the current target.
// All math in kg (lib/plates.ts); display converts at the edge. The plate
// inventory and bar options come from settings' per-unit catalogs.

import { split } from "../lib/plates";
import { BAR_CATALOG, setBarKg } from "../lib/settings";
import { useBarKg, usePlatesOnHand } from "../hooks/useSettings";
import { toDisplay, type Unit } from "../lib/units";

interface PlateSheetProps {
  exerciseName: string;
  targetKg: number;
  unit: Unit;
  /** machine = plate-loaded, no bar weight counted */
  machine: boolean;
  /** open the number pad for a new target (returns here after) */
  onTypeTarget: () => void;
  onClose: () => void;
}

export function PlateSheet({
  exerciseName,
  targetKg,
  unit,
  machine,
  onTypeTarget,
  onClose,
}: PlateSheetProps) {
  const inventory = usePlatesOnHand(unit);
  const chosenBarKg = useBarKg(unit);
  const barKg = machine ? 0 : chosenBarKg;
  const result = split(targetKg, barKg, inventory);

  const maxPlate = Math.max(...inventory, 1);
  const disp = (kg: number) => toDisplay(kg, unit);

  const note = result.exact
    ? machine
      ? "Plate-loaded machine — no bar weight counted."
      : `Exact on a ${disp(barKg)} ${unit} bar with your plates.`
    : `Closest build is ${disp(result.achievedKg)} ${unit}. Rounded down.`;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span className="sheet-title">
            {exerciseName.toUpperCase()} · PLATES
          </span>
          <button type="button" className="sheet-close" onClick={onClose}>
            CLOSE
          </button>
        </div>

        <div className="plate-target-row">
          <button
            type="button"
            className="plate-target"
            onClick={onTypeTarget}
            aria-label="type a target load"
          >
            {disp(targetKg)}
          </button>
          {!machine && (
            <span className="plate-bars">
              {BAR_CATALOG[unit].map((b) => (
                <button
                  key={b}
                  type="button"
                  className={`chip ${Math.abs(b - chosenBarKg) < 1e-6 ? "chip-on" : ""}`}
                  onClick={() => setBarKg(unit, b)}
                >
                  BAR {disp(b)}
                </button>
              ))}
            </span>
          )}
        </div>

        <div className="plate-diagram" aria-hidden="true">
          <span className="plate-bar" />
          {result.plates.flatMap((p) =>
            Array.from({ length: p.count }, (_, i) => (
              <span
                key={`${p.plate}-${i}`}
                className="plate"
                style={{
                  width: `${Math.round(9 + (p.plate / maxPlate) * 6)}px`,
                  height: `${Math.round(30 + (p.plate / maxPlate) * 70)}px`,
                }}
              />
            )),
          )}
          <span className="plate-collar" />
        </div>

        {result.plates.map((p) => (
          <div key={p.plate} className="plate-row">
            <span className="muted">
              {disp(p.plate)} {unit.toUpperCase()}
            </span>
            <span className="plate-count">× {p.count}</span>
          </div>
        ))}
        <div className="plate-row plate-total">
          <span className="muted">PER SIDE</span>
          <span>
            {disp(result.perSideKg)} {unit.toUpperCase()}
          </span>
        </div>
        <div className="plate-note">{note}</div>

        <div className="plate-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onTypeTarget}
          >
            Type a target
          </button>
          <button
            type="button"
            className="btn btn-outline-ink"
            onClick={onClose}
          >
            Back to set
          </button>
        </div>
      </div>
    </div>
  );
}
