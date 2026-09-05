// The per-set rating: one chip row, 6.5 to 10 (lib/rpe.ts owns the scale).
//
// Quiet by default, and that is the whole design. The set loop is measured in
// seconds, so nothing here may sit between the lifter and LOG: the row does
// not exist until it is asked for, and a lifter who never asks pays neither a
// tap nor a pixel. The reveal itself is not a control of its own either — it
// rides in a section head that was already on screen (see Session).
//
// The `shown` gate lives HERE rather than at the call site, so "hidden until
// asked for" is one rule with one test instead of a condition each caller has
// to remember.
//
// Unrated is a real answer: no chip is selected, tapping the selected chip
// clears it (the End screen's session RPE behaves the same), and nothing says
// a set is missing anything.

import { RPE_CHOICES } from "../lib/rpe";

interface RpeChipsProps {
  /** has the lifter asked for this exercise's rating row yet? */
  shown: boolean;
  /** the staged rating, or null for unrated */
  value: number | null;
  /** null when the selected chip is tapped again */
  onChange: (rpe: number | null) => void;
}

export function RpeChips({ shown, value, onChange }: RpeChipsProps) {
  if (!shown) return null;
  return (
    <section className="rule-section">
      <div className="section-head">
        <span className="field-label">RPE</span>
        <span className="section-meta">HOW HARD · OPTIONAL</span>
      </div>
      {/* the same grid the End screen's session RPE uses: auto-fit at the
          44px floor, so the column COUNT gives way on a narrow phone rather
          than the key */}
      <div className="rpe-grid">
        {RPE_CHOICES.map((n) => (
          <button
            key={n}
            type="button"
            className={`seg-btn rpe-btn ${value === n ? "seg-on" : ""}`}
            aria-pressed={value === n}
            aria-label={`rpe ${n}`}
            onClick={() => onChange(value === n ? null : n)}
          >
            {n}
          </button>
        ))}
      </div>
    </section>
  );
}
