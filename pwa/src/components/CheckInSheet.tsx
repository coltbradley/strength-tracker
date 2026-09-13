// Check in.
//
// Two things live in this sheet, and they save on two different rhythms.
//
// The lead action is a SPONTANEOUS check-in: a text box, five one-tap mood
// words that append themselves into it, and an optional energy rating. It is
// unlimited per day and explicit — you type or tap, then tap Check in, and
// it writes one `checkins` row (kind 'spontaneous'). This is the thing worth
// making always available, because it costs nothing to skip and something
// real when it accrues.
//
// The old three-scale MORNING panel (sleep, fatigue, soreness) still exists
// and still autosaves exactly as before — that behaviour is untouched, only
// moved behind a collapsed disclosure, because it is worth doing once a day
// and the sheet should not lead with a once-a-day thing.
import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet } from "./Sheet";
import {
  chipActive,
  checkinRow,
  getReadinessFor,
  hasCheckinContent,
  MOOD_CHIPS,
  readinessRow,
  skipRow,
  toggleChip,
  type ReadinessPanel,
} from "../lib/checkins";
import { uuid } from "../lib/uuid";
import { outbox } from "../lib/sync";
import { reportError, toast } from "../lib/errors";

interface CheckInSheetProps {
  userId: string;
  /** The device's date. The phone travels with the lifter. */
  localDate: string;
  onClose: () => void;
  /** Told when they chose "not today" on the readiness panel, so the caller
   *  can stop asking. */
  onSkipped?: () => void;
}

type Scale = {
  key: keyof ReadinessPanel;
  label: string;
  low: string;
  high: string;
};

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
  // ---- the spontaneous check-in -------------------------------------------
  const [text, setText] = useState("");
  const [energy, setEnergy] = useState<number | null>(null);

  const toggleWord = (word: string) => setText((t) => toggleChip(t, word));
  const toggleEnergy = (n: number) => setEnergy((e) => (e === n ? null : n));

  const checkIn = async () => {
    const note = text.trim();
    const row = checkinRow(
      uuid(),
      userId,
      "spontaneous",
      { note: note.length > 0 ? note : null, energy },
      new Date().toISOString(),
    );
    try {
      await outbox.enqueue({ kind: "insert", table: "checkins", payload: row });
      toast("Checked in");
    } catch (e) {
      reportError(e, "save check-in");
      return;
    }
    onClose();
  };

  // ---- the morning readiness panel, unchanged from before -----------------
  const [readinessOpen, setReadinessOpen] = useState(false);
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
    <Sheet title="Check in" onClose={onClose} tall className="pad-sheet">
      <label className="field" htmlFor="checkin-note">
        <span className="field-label">How are you feeling?</span>
        <textarea
          id="checkin-note"
          className="input"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Tap a word, or just type"
        />
      </label>

      <div className="chip-row" role="group" aria-label="Mood">
        {MOOD_CHIPS.map((word) => (
          <button
            key={word}
            type="button"
            className={`chip${chipActive(text, word) ? " chip-on" : ""}`}
            aria-pressed={chipActive(text, word)}
            onClick={() => toggleWord(word)}
          >
            {word}
          </button>
        ))}
      </div>

      <div className="field">
        <span className="field-label">Energy</span>
        <div className="chip-row scale-row" role="group" aria-label="Energy">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className={`chip scale-chip${energy === n ? " chip-on" : ""}`}
              aria-pressed={energy === n}
              aria-label={`Energy ${n} of 5`}
              onClick={() => toggleEnergy(n)}
            >
              {n}
            </button>
          ))}
        </div>
        <div className="scale-ends">
          <span>low</span>
          <span>high</span>
        </div>
      </div>

      <div className="checkin-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!hasCheckinContent(text, energy)}
          onClick={() => void checkIn()}
        >
          Check in
        </button>
      </div>

      <button
        type="button"
        className="link-btn disclosure-toggle"
        aria-expanded={readinessOpen}
        onClick={() => setReadinessOpen((o) => !o)}
      >
        Sleep, fatigue, soreness
      </button>

      {readinessOpen &&
        (!loaded ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {CORE.map((s) => (
              <div className="field" key={String(s.key)}>
                <span className="field-label">{s.label}</span>
                <div
                  className="chip-row scale-row"
                  role="group"
                  aria-label={s.label}
                >
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
                    <div
                      className="chip-row scale-row"
                      role="group"
                      aria-label={s.label}
                    >
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

            <button
              type="button"
              className="link-btn"
              onClick={() => void skip()}
            >
              Not today
            </button>
          </>
        ))}
    </Sheet>
  );
}
