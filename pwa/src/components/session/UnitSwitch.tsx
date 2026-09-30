import type { Unit } from "../../lib/units";

/** A quiet display-unit control. The parent owns the device preference. */
export function UnitSwitch({
  unit,
  onChange,
}: {
  unit: Unit;
  onChange(next: Unit): void;
}) {
  return (
    <div className="session-unit-switch" role="group" aria-label="Weight unit">
      {(["lb", "kg"] as const).map((choice) => (
        <button
          key={choice}
          type="button"
          className={`session-unit-choice${unit === choice ? " session-unit-choice-active" : ""}`}
          aria-label={`Show weights in ${choice === "lb" ? "pounds" : "kilograms"}`}
          aria-pressed={unit === choice}
          onClick={() => onChange(choice)}
        >
          {choice}
        </button>
      ))}
    </div>
  );
}
