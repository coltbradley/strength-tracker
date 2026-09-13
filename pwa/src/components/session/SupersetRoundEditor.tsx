import { SetEditor, type SetDraft, type SetEditorProps } from "./SetEditor";

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
 * Two controlled set editors joined by one durable local action. Drafts stay
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
      <div className="superset-round-label">{label}</div>
      <div className="superset-round-members">
        <section
          className="superset-round-member"
          aria-label={`${a1.tag} ${a1.editor.entry.name}`}
        >
          <div className="superset-round-member-label">
            {a1.tag} · {a1.editor.entry.name}
          </div>
          <SetEditor
            {...a1.editor}
            variant="focus"
            showLog={false}
            disabled={disabled || pendingMember === "a2" || a1.editor.disabled}
          />
        </section>
        <section
          className="superset-round-member"
          aria-label={`${a2.tag} ${a2.editor.entry.name}`}
        >
          <div className="superset-round-member-label">
            {a2.tag} · {a2.editor.entry.name}
          </div>
          <SetEditor
            {...a2.editor}
            variant="focus"
            showLog={false}
            disabled={disabled || pendingMember === "a1" || a2.editor.disabled}
          />
        </section>
      </div>
      <p className="microcopy superset-round-remaining">
        {pendingMember === "a1"
          ? `${a1.tag} remaining until this round is complete.`
          : `${a2.tag} remaining until this round is complete.`}
      </p>
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
