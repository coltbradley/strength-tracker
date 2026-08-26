// Big tappable value + stepper buttons. The value opens the number pad
// (when onTapValue is given); the buttons bump by fixed deltas, clamped to
// [min, max]. Layouts: inline (value with square buttons beside it — reps,
// bodyweight) or stacked (full-width button row under the value — load).

export interface StepDef {
  label: string;
  delta: number;
  /** fine steps render lighter */
  fine?: boolean;
}

interface StepperProps {
  display: string;
  subText?: string;
  /** accent underline (the primary value on the screen) */
  accent?: boolean;
  onTapValue?: () => void;
  value: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
  steps: StepDef[];
  inline?: boolean;
  /** aria label base, e.g. "load" */
  label: string;
}

export function Stepper({
  display,
  subText,
  accent = false,
  onTapValue,
  value,
  min = 0,
  max = Number.POSITIVE_INFINITY,
  onChange,
  steps,
  inline = false,
  label,
}: StepperProps) {
  const bump = (delta: number) => {
    const raw = Math.round((value + delta) * 100) / 100;
    onChange(Math.min(max, Math.max(min, raw)));
  };

  const valueEl = (
    <button
      type="button"
      className={`stepper-value ${accent ? "stepper-value-accent" : ""}`}
      onClick={onTapValue}
      aria-label={`${label} value — tap to type`}
      disabled={!onTapValue}
    >
      {display}
    </button>
  );

  const buttons = steps.map((s) => (
    <button
      key={s.label}
      type="button"
      className={s.fine ? "stepper-btn-fine" : "stepper-btn"}
      aria-label={`${s.delta > 0 ? "increase" : "decrease"} ${label} by ${Math.abs(s.delta)}`}
      onClick={() => bump(s.delta)}
    >
      {s.label}
    </button>
  ));

  if (inline) {
    return (
      <div className="stepper">
        <div className="stepper-inline">
          {valueEl}
          {subText !== undefined && (
            <span className="stepper-sub">{subText}</span>
          )}
          {buttons}
        </div>
      </div>
    );
  }

  return (
    <div className="stepper">
      <div className="stepper-value-row">
        {valueEl}
        {subText !== undefined && (
          <span className="stepper-sub">{subText}</span>
        )}
      </div>
      <div className="stepper-row">{buttons}</div>
    </div>
  );
}
