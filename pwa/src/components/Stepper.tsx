// Big-touch-target numeric stepper. Primary +/- uses `step`; small secondary
// buttons use `fineStep` (e.g. 2.5 kg / 0.5 kg). No keyboard anywhere.

interface StepperProps {
  label: string;
  value: number;
  display: string;
  step: number;
  fineStep?: number;
  min?: number;
  onChange: (next: number) => void;
}

export function Stepper({
  label,
  value,
  display,
  step,
  fineStep,
  min = 0,
  onChange,
}: StepperProps) {
  const bump = (delta: number) => {
    const next = Math.max(min, Math.round((value + delta) * 100) / 100);
    onChange(next);
  };

  return (
    <div className="stepper">
      <div className="stepper-label">{label}</div>
      <div className="stepper-row">
        <button
          type="button"
          className="stepper-btn"
          aria-label={`decrease ${label}`}
          onClick={() => bump(-step)}
        >
          −
        </button>
        <div className="stepper-value" aria-live="polite">
          {display}
        </div>
        <button
          type="button"
          className="stepper-btn"
          aria-label={`increase ${label}`}
          onClick={() => bump(step)}
        >
          +
        </button>
      </div>
      {fineStep !== undefined && (
        <div className="stepper-fine">
          <button
            type="button"
            className="stepper-btn-fine"
            aria-label={`decrease ${label} (fine)`}
            onClick={() => bump(-fineStep)}
          >
            −{fineStep < 1 ? fineStep : Math.round(fineStep * 10) / 10}
          </button>
          <button
            type="button"
            className="stepper-btn-fine"
            aria-label={`increase ${label} (fine)`}
            onClick={() => bump(fineStep)}
          >
            +{fineStep < 1 ? fineStep : Math.round(fineStep * 10) / 10}
          </button>
        </div>
      )}
    </div>
  );
}
