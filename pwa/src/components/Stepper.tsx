// Big tappable value + stepper buttons. The value opens the number pad
// (when onTapValue is given); the buttons bump by fixed deltas, clamped to
// [min, max].
//
// Three layouts, and the third is why this comment is long. `stacked` (the
// default) is a full-width button row under the value — the session's load.
// `inline` puts square buttons beside the value and keeps the 52px display
// type: that is the session's reps, where the display is a bare "8" and the
// value IS the control. `compact` reuses the inline geometry for the plan
// editor, where the same component renders four or five stacked rows whose
// displays are sentences ("15 reps max"). At 52px those sentences pushed the
// −/+ buttons clean off a 375px viewport, and .content only scrolls on Y, so
// the buttons were clipped and unreachable. They are different jobs, so they
// are different variants rather than one variant that guesses.

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
  /** compact editor field — inline geometry, value scaled to a field, not a
   *  headline. Implies `inline`. */
  compact?: boolean;
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
  compact = false,
  label,
}: StepperProps) {
  const bump = (delta: number) => {
    const raw = Math.round((value + delta) * 100) / 100;
    onChange(Math.min(max, Math.max(min, raw)));
  };

  // Without onTapValue there is nothing to tap, and a permanently disabled
  // button announcing "tap to type" is a lie that also sits in the tab order.
  // The plan editor renders five of them per open exercise.
  const valueEl = onTapValue ? (
    <button
      type="button"
      className={`stepper-value ${accent ? "stepper-value-accent" : ""}`}
      onClick={onTapValue}
      aria-label={`${label} value — tap to type`}
    >
      {display}
    </button>
  ) : (
    <span className={`stepper-value ${accent ? "stepper-value-accent" : ""}`}>
      {display}
    </span>
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

  if (inline || compact) {
    return (
      <div className="stepper">
        <div className={`stepper-inline${compact ? " stepper-field" : ""}`}>
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
