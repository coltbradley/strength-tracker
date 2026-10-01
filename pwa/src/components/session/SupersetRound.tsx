// The middle of the focus screen during a live superset round: one card per
// member (tag, name, the load x reps currently staged, and where it stands in
// THIS round), a one-line hint about what happens after the tap, and the
// picture of the load for the member marked NOW — the plates, pin or
// dumbbells the lifter is about to touch.
//
// A card that is not NOW and still has work to do is a button: tapping it
// logs that member next instead (the partner's warmup, an A2 first). The
// round itself is arithmetic done by lib/sessionFocus.ts; this is only the
// drawing.

import { LoadPicture, type LoadPictureModel } from "./LoadPicture";
import type { RoundCardState } from "../../lib/sessionFocus";
import type { Unit } from "../../lib/units";

export type RoundMemberState = RoundCardState;

export interface RoundMemberCard {
  tag: string;
  name: string;
  /** "135 lb × 8", already formatted */
  line: string;
  state: RoundMemberState;
  /** present while the member can be chosen as the next one to log */
  onChoose?(): void;
  /** present on a skipped member: take the skip back */
  onUnskip?(): void;
}

const STATE_TEXT: Record<RoundMemberState, string> = {
  now: "● NOW",
  done: "✓",
  next: "○ NEXT",
  skipped: "– SKIPPED",
};
const STATE_WORD: Record<RoundMemberState, string> = {
  now: "now",
  done: "done this round",
  next: "next",
  skipped: "skipped",
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
      {members.map((m) => {
        const body = (
          <>
            <span className="ss-card-tag">{m.tag}</span>
            <span className="ss-card-body">
              <b className="ss-card-name">{m.name}</b>
              <span className="ss-card-line">{m.line}</span>
            </span>
            <span className="ss-card-state" aria-hidden="true">
              {STATE_TEXT[m.state]}
            </span>
          </>
        );
        const label = `${m.tag} ${m.name}, ${m.line}, ${STATE_WORD[m.state]}`;
        if (m.onUnskip) {
          return (
            <div key={m.tag} className={`ss-card is-${m.state}`} role="group" aria-label={label}>
              {body}
              <button type="button" className="ss-card-unskip text-link" onClick={m.onUnskip}>
                Unskip {m.tag}
              </button>
            </div>
          );
        }
        return m.onChoose && m.state !== "now" ? (
          <button
            key={m.tag}
            type="button"
            className={`ss-card ss-card-choose is-${m.state}`}
            aria-label={`${label}. Log ${m.tag} next`}
            onClick={m.onChoose}
          >
            {body}
          </button>
        ) : (
          <div
            key={m.tag}
            className={`ss-card is-${m.state}`}
            role="group"
            aria-label={label}
          >
            {body}
          </div>
        );
      })}
      <p className="ss-round-hint">{hint}</p>
      {picture && <LoadPicture model={picture} unit={unit} />}
    </div>
  );
}
