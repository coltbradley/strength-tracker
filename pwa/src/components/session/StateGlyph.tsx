// The one place the app draws "where is this in the workout" — an entry in
// the progress rail, a set in FocusSetProgress, a row in WorkoutOverview.
// Shape carries the meaning (CLAUDE.md's WCAG note applies to text; this is
// the non-text equivalent of the same rule — see the state table in
// docs/superpowers/specs/2026-09-16-live-session-adaptation-design.md).
// Colour is never the only difference between two states: "next" and
// "upcoming" render the identical hollow-dot GLYPH and are told apart only
// by ink weight, which is a real, if secondary, distinction — the state that
// actually matters (done/current/skipped) never relies on it alone.
//
// Deliberately decorative (aria-hidden, no role/aria-label of its own): every
// surface that places one already has, or is given in the same change, an
// accessible name that says the same thing in words. `label` becomes a
// native `title` — a free hover hint — never a second source of truth for
// assistive tech to disagree with the first.

export type ProgressState =
  "done" | "current" | "next" | "skipped" | "upcoming";

const GLYPH: Record<ProgressState, string> = {
  done: "✓",
  current: "●",
  next: "○",
  skipped: "–",
  upcoming: "○",
};

export function StateGlyph({
  state,
  warmup = false,
  label,
}: {
  state: ProgressState;
  warmup?: boolean;
  label: string;
}) {
  return (
    <span
      className={`state-glyph state-glyph-${state}${warmup ? " state-glyph-warmup" : ""}`}
      aria-hidden="true"
      title={label}
    >
      {GLYPH[state]}
    </span>
  );
}
