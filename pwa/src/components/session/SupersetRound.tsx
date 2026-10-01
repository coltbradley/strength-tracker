// The middle of the focus screen during a live superset round: one card per
// member (tag, name, the load x reps currently staged, and where it stands in
// THIS round), a one-line hint about what happens after the tap, and the
// picture of the load for the member marked NOW — the plates, pin or
// dumbbells the lifter is about to touch.
//
// Purely presentational: Session owns the round arithmetic and every handler.

import { LoadPicture, type LoadPictureModel } from "./LoadPicture";
import type { Unit } from "../../lib/units";

export type RoundMemberState = "now" | "done" | "next";

export interface RoundMemberCard {
  tag: string;
  name: string;
  /** "135 lb × 8", already formatted */
  line: string;
  state: RoundMemberState;
}

const STATE_TEXT: Record<RoundMemberState, string> = {
  now: "● NOW",
  done: "✓",
  next: "○ NEXT",
};
const STATE_WORD: Record<RoundMemberState, string> = {
  now: "now",
  done: "done",
  next: "next",
};

export function SupersetRound({
  heading,
  members,
  hint,
  picture,
  unit,
}: {
  /** "A1 THEN A2 · REST AFTER A2" */
  heading: string;
  members: [RoundMemberCard, RoundMemberCard];
  hint: string;
  picture: LoadPictureModel | null;
  unit: Unit;
}) {
  return (
    <div className="ss-round">
      <div className="ss-round-heading">{heading}</div>
      {members.map((m) => (
        <div
          key={m.tag}
          className={`ss-card${m.state === "now" ? " is-now" : ""}`}
          aria-label={`${m.tag} ${m.name}, ${m.line}, ${STATE_WORD[m.state]}`}
        >
          <span className="ss-card-tag">{m.tag}</span>
          <span className="ss-card-body">
            <b className="ss-card-name">{m.name}</b>
            <span className="ss-card-line">{m.line}</span>
          </span>
          <span className="ss-card-state" aria-hidden="true">
            {STATE_TEXT[m.state]}
          </span>
        </div>
      ))}
      <p className="ss-round-hint">{hint}</p>
      {picture && <LoadPicture model={picture} unit={unit} />}
    </div>
  );
}
