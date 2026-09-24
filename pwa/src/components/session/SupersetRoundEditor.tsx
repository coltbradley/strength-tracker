import { Stepper, type StepDef } from "../Stepper";
import { toDisplay } from "../../lib/units";
import type { SetDraft, SetEditorProps } from "./SetEditor";

export interface SupersetRoundMember {
  tag: string;
  target?: string | null;
  editor: SetEditorProps;
}

export interface SupersetRoundEditorProps {
  label: string;
  a1: SupersetRoundMember;
  a2: SupersetRoundMember;
  disabled?: boolean;
  /** One `--motion-fast` pulse on whichever LOG action is showing, for a tap
   *  that landed on the 200 ms duplicate-tap lock (Session's `logHeld`). */
  heldPulse?: boolean;
  error?: string | null;
  singleLogLabel?: string;
  /** The one member still missing from a partially persisted round. */
  pendingMember?: "a1" | "a2" | null;
  onLogRound(drafts: { a1: SetDraft; a2: SetDraft }): void;
  onLogA1Only(): void;
  onLogA2Only(): void;
}

/**
 * ONE compact row per member: load (secondary to the single-exercise hero,
 * never competing with it) × reps, with the load's own coarse step beside
 * it. No PlateBar — a round has two of these and must still fit one screen
 * with LOG ROUND anchored at the bottom, and a diagram earns its place only
 * where it is the only thing being decided (see the single-exercise hero).
 */
function MemberRow({ member }: { member: SupersetRoundMember }) {
  const {
    entry,
    draft,
    loadPresentation,
    unit,
    maxEntryKg,
    loadSteps,
    onDraftChange,
    onOpenPad,
  } = member.editor;
  const { perSide, totalKg } = loadPresentation;
  const displayLoad =
    draft.enteredLoad !== undefined && draft.enteredUnit === unit
      ? draft.enteredLoad
      : toDisplay(draft.entryKg, unit);
  const coarseDown: StepDef | undefined = loadSteps[0];
  const coarseUp: StepDef | undefined = loadSteps[loadSteps.length - 1];

  return (
    <section
      className="superset-member-card"
      aria-label={`${member.tag} ${entry.name}`}
    >
      <div className="superset-round-member-label">
        {member.tag} · {entry.name}
      </div>
      {member.target && <div className="superset-member-target">{member.target}</div>}
      <div className="superset-member-row">
        <Stepper
          label="load"
          inline
          display={String(displayLoad)}
          subText={unit}
          onTapValue={
            onOpenPad === undefined ? undefined : () => onOpenPad("load")
          }
          snap
          value={draft.entryKg}
          min={0}
          max={maxEntryKg}
          onChange={(entryKg) =>
            onDraftChange({
              entryKg,
              enteredLoad: toDisplay(entryKg, unit),
              enteredUnit: unit,
            })
          }
          steps={[coarseDown, coarseUp].filter(
            (s): s is StepDef => s !== undefined,
          )}
        />
        <span className="superset-member-x" aria-hidden="true">
          ×
        </span>
        <Stepper
          label="reps"
          inline
          display={String(draft.reps)}
          onTapValue={
            onOpenPad === undefined ? undefined : () => onOpenPad("reps")
          }
          value={draft.reps}
          min={0}
          max={100}
          onChange={(reps) => onDraftChange({ reps: Math.round(reps) })}
          steps={[]}
        />
      </div>
      {perSide && (
        <div className="microcopy superset-member-detail">
          EACH HAND × 2 · {toDisplay(totalKg, unit)} {unit.toUpperCase()} TOTAL
        </div>
      )}
      {member.editor.lastPerformance !== null &&
        member.editor.lastPerformance !== undefined && (
          <div className="superset-member-history">
            {member.editor.lastPerformance}
          </div>
        )}
    </section>
  );
}

/**
 * Two compact member rows joined by one durable local action. Drafts stay
 * owned by Session, so an interrupted local write leaves both values intact.
 */
export function SupersetRoundEditor({
  label,
  a1,
  a2,
  disabled = false,
  heldPulse = false,
  error = null,
  singleLogLabel = `Log ${a1.editor.entry.name} only`,
  pendingMember = null,
  onLogRound,
  onLogA1Only,
  onLogA2Only,
}: SupersetRoundEditorProps) {
  const controlsLabel = label.replace(/\s*·\s*ROUND\b.*$/i, "").trim();
  const heldClass = heldPulse ? " is-held" : "";

  return (
    <section className="superset-round-editor" aria-label={controlsLabel}>
      <div className="superset-round-members">
        <MemberRow member={a1} />
        <MemberRow member={a2} />
      </div>
      {error !== null && (
        <p className="superset-round-error" role="alert">
          {error}
        </p>
      )}
      <div className="superset-round-actions">
        {pendingMember === null ? (
          <>
            <button
              type="button"
              className={`btn btn-primary btn-log${heldClass}`}
              disabled={disabled}
              onClick={() =>
                onLogRound({ a1: a1.editor.draft, a2: a2.editor.draft })
              }
            >
              Log round
            </button>
            <button
              type="button"
              className={`btn btn-ghost btn-block superset-partial-action${heldClass}`}
              disabled={disabled}
              onClick={onLogA1Only}
            >
              {singleLogLabel}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`btn btn-ghost btn-block superset-partial-action${heldClass}`}
            disabled={disabled}
            onClick={pendingMember === "a1" ? onLogA1Only : onLogA2Only}
          >
            Log {pendingMember === "a1" ? a1.editor.entry.name : a2.editor.entry.name} only
          </button>
        )}
      </div>
    </section>
  );
}
