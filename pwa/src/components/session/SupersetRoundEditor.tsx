import { Stepper, type StepDef } from "../Stepper";
import { toDisplay } from "../../lib/units";
import type { SetDraft, SetEditorProps } from "./SetEditor";

export interface SupersetRoundMember {
  tag: string;
  editor: SetEditorProps;
}

export interface SupersetRoundEditorProps {
  label: string;
  a1: SupersetRoundMember;
  a2: SupersetRoundMember;
  disabled?: boolean;
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
  const { perSide } = loadPresentation;
  const coarseDown: StepDef | undefined = loadSteps[0];
  const coarseUp: StepDef | undefined = loadSteps[loadSteps.length - 1];

  return (
    <section
      className="superset-member-compact"
      aria-label={`${member.tag} ${entry.name}`}
    >
      <div className="superset-round-member-label">
        {member.tag} · {entry.name}
      </div>
      <div className="superset-member-row">
        <Stepper
          label="load"
          inline
          display={String(toDisplay(draft.entryKg, unit))}
          subText={unit}
          onTapValue={
            onOpenPad === undefined ? undefined : () => onOpenPad("load")
          }
          snap
          value={draft.entryKg}
          min={0}
          max={maxEntryKg}
          onChange={(entryKg) => onDraftChange({ entryKg })}
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
          {toDisplay(draft.entryKg, unit)} × 2
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
  error = null,
  singleLogLabel = "Log A1 only",
  pendingMember = null,
  onLogRound,
  onLogA1Only,
  onLogA2Only,
}: SupersetRoundEditorProps) {
  return (
    <section className="superset-round-editor" aria-label={label}>
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
              className="btn btn-primary btn-log"
              disabled={disabled}
              onClick={() =>
                onLogRound({ a1: a1.editor.draft, a2: a2.editor.draft })
              }
            >
              Log round
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-block"
              disabled={disabled}
              onClick={onLogA1Only}
            >
              {singleLogLabel}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-log"
            disabled={disabled}
            onClick={pendingMember === "a1" ? onLogA1Only : onLogA2Only}
          >
            Log {pendingMember === "a1" ? a1.tag : a2.tag} only
          </button>
        )}
      </div>
    </section>
  );
}
