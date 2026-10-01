import type { SessionPresentation } from "../../lib/sessionFocus";

export interface FocusListSwitchProps {
  value: SessionPresentation;
  onChange(next: SessionPresentation): void;
}

/** A controlled presentation switch. The session screen owns the mode. */
export function FocusListSwitch({ value, onChange }: FocusListSwitchProps) {
  return (
    <div className="focus-list-switch" role="group" aria-label="Session view">
      <button
        type="button"
        aria-pressed={value === "focus"}
        onClick={() => onChange("focus")}
      >
        Focus
      </button>
      <button
        type="button"
        aria-pressed={value === "overview"}
        onClick={() => onChange("overview")}
      >
        List
      </button>
    </div>
  );
}
