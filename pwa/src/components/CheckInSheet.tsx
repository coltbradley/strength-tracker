// The morning panel.
//
// Every item is skippable and the sheet saves with nothing answered. That is
// the whole design: a panel somebody must complete is a panel somebody stops
// opening, and this data is only worth anything if it accrues every day. The
// views carry per-item counts so a half-filled row is never read as a full one.
//
// Tapping the selected value again CLEARS it. Without that there is no way back
// from a mis-tap except closing the sheet, and a question you cannot un-answer
// is one people answer carelessly.
import { useEffect, useState } from "react";
import { Sheet } from "./Sheet";
import {
  answeredItems,
  getReadinessFor,
  readinessRow,
  type ReadinessPanel,
} from "../lib/checkins";
import { outbox } from "../lib/sync";
import { reportError } from "../lib/errors";

interface CheckInSheetProps {
  userId: string;
  /** The device's date. The phone travels with the lifter. */
  localDate: string;
  onClose: () => void;
  onSaved?: (answered: number) => void;
}

const SCALES: {
  key: keyof ReadinessPanel;
  label: string;
  low: string;
  high: string;
}[] = [
  { key: "sleep_quality", label: "Sleep quality", low: "poor", high: "great" },
  { key: "fatigue", label: "Fatigue", low: "fresh", high: "wrecked" },
  { key: "soreness", label: "Soreness", low: "none", high: "very" },
  { key: "stress", label: "Stress", low: "calm", high: "frazzled" },
  { key: "mood", label: "Mood", low: "low", high: "good" },
];

export function CheckInSheet({
  userId,
  localDate,
  onClose,
  onSaved,
}: CheckInSheetProps) {
  const [panel, setPanel] = useState<ReadinessPanel>({});
  const [rowId, setRowId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);

  // Today's panel first, so a correction merges onto the row it corrects
  // rather than colliding with unique (user_id, local_date).
  useEffect(() => {
    let live = true;
    getReadinessFor(userId, localDate).then((existing) => {
      if (!live) return;
      if (existing) {
        setRowId(existing.id);
        const { id: _id, local_date: _d, recorded_at: _r, ...rest } = existing;
        setPanel(rest);
      }
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [userId, localDate]);

  const set = (key: keyof ReadinessPanel, value: unknown) =>
    setPanel((p) => ({ ...p, [key]: value }));

  const toggleScale = (key: keyof ReadinessPanel, value: number) =>
    // Tapping the current value again clears it back to unanswered.
    set(key, panel[key] === value ? null : value);

  const save = async () => {
    setSaving(true);
    try {
      const id = rowId ?? crypto.randomUUID();
      await outbox.enqueue({
        kind: "insert",
        table: "daily_readiness",
        payload: readinessRow(
          id,
          userId,
          localDate,
          panel,
          new Date().toISOString(),
        ),
      });
      onSaved?.(answeredItems(panel));
      onClose();
    } catch (e) {
      reportError(e, "save check-in");
      setSaving(false);
    }
  };

  const answered = answeredItems(panel);

  return (
    <Sheet title="Morning check-in" onClose={onClose} tall className="pad-sheet">
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="muted checkin-intro">
            Answer what you know. Skipping is fine — tap a chosen value again to
            clear it.
          </p>

          <label className="field">
            <span className="field-label">Sleep</span>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              step="0.5"
              min="0"
              max="24"
              placeholder="hours"
              value={panel.sleep_hours ?? ""}
              onChange={(e) =>
                set(
                  "sleep_hours",
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
            />
          </label>

          {SCALES.map((s) => (
            <div className="field" key={String(s.key)}>
              <span className="field-label">{s.label}</span>
              <div className="chip-row scale-row" role="group" aria-label={s.label}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`chip scale-chip${panel[s.key] === n ? " chip-on" : ""}`}
                    aria-pressed={panel[s.key] === n}
                    aria-label={`${s.label} ${n} of 5`}
                    onClick={() => toggleScale(s.key, n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="scale-ends">
                <span>{s.low}</span>
                <span>{s.high}</span>
              </div>
            </div>
          ))}

          <button
            type="button"
            className="link-btn"
            aria-expanded={more}
            onClick={() => setMore((m) => !m)}
          >
            {more ? "Fewer" : "Anything else?"}
          </button>

          {more && (
            <>
              {/* Context that EXPLAINS a bad reading rather than scoring it.
                  Without these a poor day looks like accumulated training load
                  when it was a late flight. */}
              <label className="field">
                <span className="field-label">Bodyweight (kg)</span>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  value={panel.bodyweight_kg ?? ""}
                  onChange={(e) =>
                    set(
                      "bodyweight_kg",
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                />
              </label>
              <label className="field">
                <span className="field-label">Resting HR</span>
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  value={panel.resting_hr ?? ""}
                  onChange={(e) =>
                    set(
                      "resting_hr",
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                />
              </label>
              <label className="field checkbox-field">
                <input
                  type="checkbox"
                  checked={panel.illness === true}
                  onChange={(e) => set("illness", e.target.checked || null)}
                />
                <span>Feeling ill</span>
              </label>
              <label className="field checkbox-field">
                <input
                  type="checkbox"
                  checked={panel.travel === true}
                  onChange={(e) => set("travel", e.target.checked || null)}
                />
                <span>Travelling</span>
              </label>
              <label className="field">
                <span className="field-label">Note</span>
                <textarea
                  className="input"
                  rows={2}
                  maxLength={1000}
                  value={panel.note ?? ""}
                  onChange={(e) => set("note", e.target.value || null)}
                />
              </label>
            </>
          )}

          <div className="checkin-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={save}
            >
              {/* Saving nothing is legal and the button says so, rather than
                  being disabled and leaving somebody stuck on a question they
                  do not want to answer. */}
              {answered === 0 ? "Save (nothing today)" : "Save"}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
