// Saved workouts: pick one to drop onto a day.
//
// The point of the list is the promise underneath it — loads come from what
// you last actually lifted, not from the numbers frozen into the template when
// you saved it. A template saved three months ago would otherwise walk your
// strength backwards every time you used it. That is said out loud here,
// because a person choosing "Push A" has no other way to know which numbers
// they are about to get.
import { useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import { getTemplates, type TemplateRow } from "../lib/data";
import { reportError } from "../lib/errors";
import { useArmed } from "../hooks/useArmed";

interface TemplateSheetProps {
  /** the day the chosen template will be applied to, for the heading */
  dateLabel: string;
  busy: boolean;
  onApply: (t: TemplateRow) => void;
  onDelete: (t: TemplateRow) => void;
  onClose: () => void;
}

export function TemplateSheet({
  dateLabel,
  busy,
  onApply,
  onDelete,
  onClose,
}: TemplateSheetProps) {
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [confirming, setConfirming] = useArmed();

  useEffect(() => {
    getTemplates()
      .then(setRows)
      .catch((e: unknown) => {
        reportError(e, "load templates");
        setRows([]);
      });
  }, []);

  return (
    <Sheet title="Saved workouts" onClose={onClose} tall>
      <div className="microcopy">
        Adding to {dateLabel}. Weights come from the last time you actually did
        each exercise, not from what the template was saved with.
      </div>

      {rows === null && <p className="muted">Loading…</p>}

      {rows?.length === 0 && (
        <p className="microcopy">
          No saved workouts yet. Open any planned day and choose “Save as
          template” to keep it.
        </p>
      )}

      {rows?.map((t) => (
        <div key={t.id} className="week-item">
          <button
            type="button"
            className="week-row"
            disabled={busy}
            onClick={() => onApply(t)}
          >
            <span className="week-label">{t.label ?? "Untitled"}</span>
            <span className="week-state">
              {t.exercise_count}{" "}
              {t.exercise_count === 1 ? "exercise" : "exercises"}
            </span>
          </button>
          <button
            type="button"
            className={`btn btn-block ${confirming === t.id ? "btn-danger" : "btn-ghost"}`}
            disabled={busy}
            onClick={() =>
              confirming === t.id ? onDelete(t) : setConfirming(t.id)
            }
          >
            {confirming === t.id ? "Delete template?" : "Delete"}
          </button>
          {confirming === t.id && (
            <div className="microcopy">
              Removes the saved workout only. Days you already made from it are
              copies and are not touched.
            </div>
          )}
        </div>
      ))}
    </Sheet>
  );
}
