// Plate sheet: what is on the bar (or pinned in the stack) for the current
// target. All math in kg (lib/plates.ts); display converts at the edge.
//
// The base weight (bar, or a plate-loaded machine's sled) is a per-exercise
// preference — `ExercisePref.barKg` — and only changes how plates are worked
// out; the logged load is always the TOTAL. A machine or cable exercise can
// be a plate sled or a pin stack, and the sheet switches between the two
// (`ExercisePref.loadStyle`); a stack has nothing to calculate, so the base
// weight is hidden there.

import { Sheet } from "./Sheet";
import { PlateDiagram, StackDrawing } from "./session/LoadPicture";
import { split } from "../lib/plates";
import { plateText } from "../lib/loadPicture";
import { offersLoadStyle, resolveLoadStyle } from "../lib/loadStyle";
import {
  MAX_BAR_KG,
  setExerciseBarKg,
  setExerciseLoadStyle,
} from "../lib/settings";
import {
  useExerciseBarKg,
  useExercisePref,
  usePlatesOnHand,
} from "../hooks/useSettings";
import { formatPlate } from "../lib/format";
import { fromDisplay, toDisplay, type Unit } from "../lib/units";

interface PlateSheetProps {
  exerciseId: string;
  exerciseName: string;
  targetKg: number;
  unit: Unit;
  /** equipment tag drives the default bar (barbell = bar, else none) and
   *  whether the plate sled / pin stack switch is offered */
  equipment: string | null;
  /** open the number pad for a new target (returns here after) */
  onTypeTarget: () => void;
  /** open the number pad for a new base weight (returns here after) */
  onTypeBase: () => void;
  onClose: () => void;
}

/** One plate step of base weight: 5 lb, or 2.5 kg. */
const BASE_STEP: Record<Unit, number> = { kg: 2.5, lb: 5 };

export function PlateSheet({
  exerciseId,
  exerciseName,
  targetKg,
  unit,
  equipment,
  onTypeTarget,
  onTypeBase,
  onClose,
}: PlateSheetProps) {
  const inventory = usePlatesOnHand(unit);
  const barKg = useExerciseBarKg(exerciseId, unit, equipment);
  const pref = useExercisePref(exerciseId);

  const canSwitch = offersLoadStyle(equipment, exerciseName);
  const style = canSwitch
    ? resolveLoadStyle(pref.loadStyle, equipment, exerciseName)
    : "plates";
  const isStack = style === "stack";
  const isBarbell = equipment === "barbell";

  const result = split(targetKg, barKg, inventory);
  const disp = (kg: number) => toDisplay(kg, unit);
  const total = disp(targetKg);

  const stepBase = (dir: 1 | -1) => {
    const cur = toDisplay(barKg, unit);
    const nextDisplay = Math.max(0, Math.round((cur + dir * BASE_STEP[unit]) * 100) / 100);
    const nextKg = Math.min(
      MAX_BAR_KG,
      Math.round(fromDisplay(nextDisplay, unit) * 100) / 100,
    );
    setExerciseBarKg(exerciseId, nextKg);
  };

  return (
    <Sheet title={`${exerciseName.toUpperCase()} · PLATES`} onClose={onClose}>
      <button
        type="button"
        className="plate-total-btn"
        onClick={onTypeTarget}
        aria-label="type a target load"
      >
        <span className="plate-target">{total}</span>
        <span className="plate-total-unit">{unit} total</span>
      </button>

      {canSwitch && (
        <div className="plate-which">
          <span className="plate-which-label">Which machine?</span>
          <div className="seg" role="group" aria-label="Which machine?">
            <button
              type="button"
              className={`seg-btn ${!isStack ? "seg-on" : ""}`}
              aria-pressed={!isStack}
              onClick={() => setExerciseLoadStyle(exerciseId, "plates")}
            >
              Plate sled
            </button>
            <button
              type="button"
              className={`seg-btn ${isStack ? "seg-on" : ""}`}
              aria-pressed={isStack}
              onClick={() => setExerciseLoadStyle(exerciseId, "stack")}
            >
              Pin stack
            </button>
          </div>
        </div>
      )}

      {isStack ? (
        <div className="plate-picture plate-picture-stack">
          <StackDrawing totalKg={targetKg} unit={unit} />
          <span className="plate-text">
            Pin at {total} {unit}
          </span>
        </div>
      ) : (
        <>
          <div className="plate-picture">
            <PlateDiagram split={result} unit={unit} />
            <span className="plate-text">{plateText(result, barKg, unit)}</span>
          </div>
          {!result.exact && (
            <div className="plate-warn" role="alert">
              Can’t make {total} {unit} exactly with your plates. Closest is{" "}
              {disp(result.achievedKg)} {unit}.
            </div>
          )}
          <div className="plate-base">
            <div className="plate-base-head">
              <span className="plate-base-label">
                BASE WEIGHT · {isBarbell ? "BAR" : "SLED"}
              </span>
              <span className="plate-base-value">
                {formatPlate(barKg, unit)} {unit}
              </span>
            </div>
            <div className="plate-base-keys">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => stepBase(-1)}
                disabled={barKg <= 0}
                aria-label="decrease base weight"
              >
                −
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onTypeBase}
              >
                Type
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => stepBase(1)}
                disabled={barKg >= MAX_BAR_KG}
                aria-label="increase base weight"
              >
                +
              </button>
            </div>
          </div>
        </>
      )}

      <div className="plate-note">
        Remembered for {exerciseName}. Only changes how plates are worked out;
        the logged load is still the total.
      </div>
    </Sheet>
  );
}
