// Plate calculator sheet: what to put on the bar for the current target.
// All math in kg (lib/plates.ts); display converts at the edge. The bar is
// chosen PER EXERCISE (a leg press has none, a squat has 20 kg) and the
// choice persists — see settings.getExerciseBarKg.

import { Sheet } from "./Sheet";
import { split } from "../lib/plates";
import { BAR_CATALOG, setExerciseBarKg } from "../lib/settings";
import { useExerciseBarKg, usePlatesOnHand } from "../hooks/useSettings";
import { formatPlate } from "../lib/format";
import { toDisplay, type Unit } from "../lib/units";

interface PlateSheetProps {
  exerciseId: string;
  exerciseName: string;
  targetKg: number;
  unit: Unit;
  /** equipment tag drives the default bar (barbell = bar, else none) */
  equipment: string | null;
  /** open the number pad for a new target (returns here after) */
  onTypeTarget: () => void;
  onClose: () => void;
}

export function PlateSheet({
  exerciseId,
  exerciseName,
  targetKg,
  unit,
  equipment,
  onTypeTarget,
  onClose,
}: PlateSheetProps) {
  const inventory = usePlatesOnHand(unit);
  const barKg = useExerciseBarKg(exerciseId, unit, equipment);
  const result = split(targetKg, barKg, inventory);

  const maxPlate = Math.max(...inventory, 1);
  const disp = (kg: number) => toDisplay(kg, unit);
  // things you pick up off a rack are labelled, not rounded — see formatPlate
  const iron = (kg: number) => formatPlate(kg, unit);

  const note = result.exact
    ? barKg === 0
      ? "Plate-loaded — no bar weight counted."
      : `Exact on a ${iron(barKg)} ${unit} bar with your plates.`
    : `Closest build is ${disp(result.achievedKg)} ${unit}. Rounded down.`;

  return (
    <Sheet title={`${exerciseName.toUpperCase()} · PLATES`} onClose={onClose}>
      <div className="plate-target-row">
        <button
          type="button"
          className="plate-target"
          onClick={onTypeTarget}
          aria-label="type a target load"
        >
          {disp(targetKg)}
        </button>
        <span className="plate-bars">
          <button
            type="button"
            className={`chip ${barKg === 0 ? "chip-on" : ""}`}
            onClick={() => setExerciseBarKg(exerciseId, 0)}
          >
            NO BAR
          </button>
          {BAR_CATALOG[unit].map((b) => (
            <button
              key={b}
              type="button"
              className={`chip ${Math.abs(b - barKg) < 1e-6 ? "chip-on" : ""}`}
              onClick={() => setExerciseBarKg(exerciseId, b)}
            >
              BAR {iron(b)}
            </button>
          ))}
        </span>
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
            {iron(p.plate)} {unit.toUpperCase()}
          </span>
          <span className="plate-count">× {p.count}</span>
        </div>
      ))}
      <div className="plate-row plate-total">
        <span className="muted">PER SIDE</span>
        <span>
          {iron(result.perSideKg)} {unit.toUpperCase()}
        </span>
      </div>
      <div className="plate-note">{note}</div>

      {/* CLOSE in the head is the exit, matching every other sheet */}
      <div className="plate-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onTypeTarget}
        >
          Type a target
        </button>
      </div>
    </Sheet>
  );
}
