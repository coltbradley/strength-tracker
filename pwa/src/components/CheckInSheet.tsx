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
import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet } from "./Sheet";
import {
  getReadinessFor,
  readinessRow,
  skipRow,
  type ReadinessPanel,
} from "../lib/checkins";
import { outbox } from "../lib/sync";
import { reportError } from "../lib/errors";

interface CheckInSheetProps {
  userId: string;
  /** The device's date. The phone travels with the lifter. */
  localDate: string;
  onClose: () => void;
  /** Told when they chose "not today", so the caller can stop asking. */
  onSkipped?: () => void;
}

type Scale = {
  key: keyof ReadinessPanel;
  label: string;
  low: string;
  high: string;
};

/**
 * Three questions, three taps, no keyboard, no scrolling.
 *
 * There were eight. The evidence (Saw 2016) validates the CLASS of subjective
 * wellness measures, not any particular panel, so the length was a choice and
 * the wrong one: a panel that takes a minute gets answered for a fortnight, and
 * this data is only worth anything if it accrues for months. Sleep explains
 * most bad days, fatigue is the readiness item, and soreness is the one that
 * points at injury. Stress and mood move with fatigue closely enough that a
 * third correlated tap buys little.
 *
 * The columns for the rest still exist and still work -- nothing was dropped
 * from the schema, and anyone who wants them has them one tap away.
 */
const CORE: Scale[] = [
  { key: "sleep_quality", label: "Sleep", low: "poor", high: "great" },
  { key: "fatigue", label: "Fatigue", low: "fresh", high: "wrecked" },
  { key: "soreness", label: "Soreness", low: "none", high: "very" },
];

const EXTRA: Scale[] = [
  { key: "stress", label: "Stress", low: "calm", high: "frazzled" },
  { key: "mood", label: "Mood", low: "low", high: "good" },
];

export function CheckInSheet({
  userId,
  localDate,
  onClose,
  onSkipped,
}: CheckInSheetProps) {
  const [panel, setPanel] = useState<ReadinessPanel>({});
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  // The panel is saved as it is answered, so closing it -- by the X, by ESC, by
  // the OS killing the app -- keeps whatever was given. There is no Save button
  // and therefore nothing to fail to press: the lowest-stakes version of a
  // question is one you cannot get wrong by walking away from it.
  const idRef = useRef<string | null>(null);
  const panelRef = useRef<ReadinessPanel>({});
  const dirtyRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);

  // Today's panel first, so a correction merges onto the row it corrects
  // rather than colliding with unique (user_id, local_date).
  useEffect(() => {
    let live = true;
    getReadinessFor(userId, localDate).then((existing) => {
      if (!live) return;
      if (existing) {
        idRef.current = existing.id;
        const { id: _id, local_date: _d, recorded_at: _r, ...rest } = existing;
        setPanel(rest);
        panelRef.current = rest;
      }
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [userId, localDate]);

  const write = useCallback(async () => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const id = (idRef.current ??= crypto.randomUUID());
    try {
      await outbox.enqueue({
        kind: "insert",
        table: "daily_readiness",
        payload: readinessRow(
          id,
          userId,
          localDate,
          panelRef.current,
          new Date().toISOString(),
        ),
      });
    } catch (e) {
      // Queued writes do not normally throw; if this one did the answer is
      // gone, and saying so beats a silent loss of the thing they just gave.
      dirtyRef.current = true;
      reportError(e, "save check-in");
    }
  }, [userId, localDate]);

  const set = (key: keyof ReadinessPanel, value: unknown) => {
    setPanel((p) => {
      const next = { ...p, [key]: value };
      panelRef.current = next;
      return next;
    });
    dirtyRef.current = true;
    window.clearTimeout(timerRef.current);
    // Debounced rather than per tap: three quick answers are one write, and a
    // merge on a stable id makes a replay free either way.
    timerRef.current = window.setTimeout(() => void write(), 700);
  };

  // Whatever was answered survives the sheet closing, however it closed.
  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      void write();
    },
    [write],
  );

  const toggleScale = (key: keyof ReadinessPanel, value: number) =>
    // Tapping the current value again clears it back to unanswered.
    set(key, panel[key] === value ? null : value);

  /** "Not today", recorded so the asking actually stops. */
  const skip = async () => {
    try {
      await outbox.enqueue({
        kind: "insert",
        table: "report_prompts",
        payload: skipRow(
          crypto.randomUUID(),
          userId,
          "daily_readiness",
          new Date().toISOString(),
        ),
      });
    } catch (e) {
      reportError(e, "skip check-in");
    }
    onSkipped?.();
    onClose();
  };

  return (
    <Sheet title="Morning check-in" onClose={onClose} tall className="pad-sheet">
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="muted checkin-intro">
            Three taps, or none. It saves as you go, so you can just close it.
          </p>

          {CORE.map((s) => (
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
              {EXTRA.map((s) => (
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
                </div>
              ))}
              <label className="field">
                <span className="field-label">Sleep (hours)</span>
                <input
                  className="input"
                  type="number"
                  inputMode="decimal"
                  step="0.5"
                  min="0"
                  max="24"
                  value={panel.sleep_hours ?? ""}
                  onChange={(e) =>
                    set(
                      "sleep_hours",
                      e.target.value === "" ? null : Number(e.target.value),
                    )
                  }
                />
              </label>
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
            {/* No Save. The answers are already saved; this just closes, and
                "not today" is a real answer that stops the asking rather than
                leaving the prompt to come back. */}
            {/* "Done" whether or not anything was answered. It said "Close"
                on an untouched panel, which collided with the sheet's own
                dismiss control -- two buttons with one name is a screen reader
                reading the same word twice and meaning different things. */}
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Done
            </button>
            <button type="button" className="link-btn" onClick={skip}>
              Not today
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
