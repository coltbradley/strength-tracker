// "Add an exercise" as a question, not a form.
//
// Adding an exercise used to drop a bare 3x8-by-feel row into the day and
// leave you to expand it and fill in everything. That is fine if you already
// know the editor; it is a blank stare if you do not. This asks the three
// things a workout actually needs, in the order a person thinks of them:
// how many sets, what weight on each, and which of them are warmups.
//
// Per-set weight is not a new data shape. It is the ramp convention that has
// always been here: consecutive prescriptions naming the SAME exercise are one
// entry ("1x8 @60 · 1x6 @85 · 3x3 @112"). This sheet just makes writing one a
// matter of typing three numbers instead of adding the same exercise three
// times and knowing that means something. Consecutive sets that agree on
// weight AND warmup collapse back into a single row on save, so the common
// "3x5, all the same" stays one prescription and does not become three.
import { useState } from "react";
import { Sheet } from "./Sheet";
import { Stepper } from "./Stepper";
import { formatStoredTwin } from "../lib/format";
import { stepKg, toDisplay, type Unit } from "../lib/units";
import type { SetType } from "../lib/types";

/** One prescription row to be written: N identical sets at one load. */
export interface SetGroup {
  sets: number;
  reps_min: number;
  reps_max: number;
  load_kg: number | null;
  set_type: SetType;
}

interface PlannedSet {
  loadKg: number;
  warmup: boolean;
}

const MAX_SETS = 20;

/**
 * Collapse consecutive sets that agree on load AND type into one prescription.
 * "3 sets of 100" is one row; "60, 80, 100, 100" is three.
 */
export function groupSets(
  sets: PlannedSet[],
  repsMin: number,
  repsMax: number,
  byFeel: boolean,
): SetGroup[] {
  const out: SetGroup[] = [];
  for (const s of sets) {
    const type: SetType = s.warmup ? "warmup" : "working";
    const load = byFeel ? null : s.loadKg;
    const last = out[out.length - 1];
    if (last !== undefined && last.load_kg === load && last.set_type === type) {
      last.sets += 1;
      continue;
    }
    out.push({
      sets: 1,
      reps_min: repsMin,
      reps_max: Math.max(repsMin, repsMax),
      load_kg: load,
      set_type: type,
    });
  }
  return out;
}

interface SetSchemeSheetProps {
  exerciseName: string;
  unit: Unit;
  /** Best guess at a starting weight — last time's top set, or the fallback. */
  startKg: number;
  busy: boolean;
  onCancel: () => void;
  onSave: (groups: SetGroup[]) => void;
}

export function SetSchemeSheet({
  exerciseName,
  unit,
  startKg,
  busy,
  onCancel,
  onSave,
}: SetSchemeSheetProps) {
  const [sets, setSets] = useState<PlannedSet[]>(() =>
    Array.from({ length: 3 }, () => ({ loadKg: startKg, warmup: false })),
  );
  const [repsMin, setRepsMin] = useState(8);
  const [repsMax, setRepsMax] = useState(8);
  // "By feel" is a real prescription, not a missing one — the coach saying
  // "work up to something hard". Keeping it here means the weight steppers can
  // stay simple numbers instead of each carrying an empty state.
  const [byFeel, setByFeel] = useState(false);

  /** Growing copies the last set, which is what "one more set" means. */
  const resize = (n: number) => {
    setSets((prev) => {
      if (n <= prev.length) return prev.slice(0, Math.max(1, n));
      const last = prev[prev.length - 1] ?? { loadKg: startKg, warmup: false };
      return [
        ...prev,
        ...Array.from({ length: n - prev.length }, () => ({ ...last })),
      ];
    });
  };

  const patch = (i: number, next: Partial<PlannedSet>) =>
    setSets((prev) => prev.map((s, j) => (j === i ? { ...s, ...next } : s)));

  /** Apply set 1's weight to everything below it. The "actually they're all
   *  the same" escape hatch, so a straight 5x5 is two taps, not five. */
  const matchAll = () =>
    setSets((prev) => prev.map((s) => ({ ...s, loadKg: prev[0]!.loadKg })));

  const groups = groupSets(sets, repsMin, repsMax, byFeel);
  const working = sets.filter((s) => !s.warmup).length;

  return (
    <Sheet title={exerciseName} onClose={onCancel} tall>
      <div className="field-label">HOW MANY SETS?</div>
      <Stepper
        label="sets"
        display={`${sets.length} ${sets.length === 1 ? "set" : "sets"}`}
        subText={
          working === sets.length
            ? undefined
            : `${working} working · ${sets.length - working} warmup`
        }
        accent
        value={sets.length}
        min={1}
        max={MAX_SETS}
        onChange={(v) => resize(Math.round(v))}
        steps={[
          { label: "−", delta: -1 },
          { label: "+", delta: 1 },
        ]}
      />

      <div className="field-label">REPS</div>
      <div className="scheme-reps">
        <Stepper
          label="reps min"
          compact
          display={`${repsMin} min`}
          value={repsMin}
          min={1}
          max={100}
          onChange={(v) => {
            const n = Math.round(v);
            setRepsMin(n);
            if (n > repsMax) setRepsMax(n);
          }}
          steps={[
            { label: "−", delta: -1 },
            { label: "+", delta: 1 },
          ]}
        />
        <Stepper
          label="reps max"
          compact
          display={`${repsMax} max`}
          value={repsMax}
          min={repsMin}
          max={100}
          onChange={(v) => setRepsMax(Math.round(v))}
          steps={[
            { label: "−", delta: -1 },
            { label: "+", delta: 1 },
          ]}
        />
      </div>

      <div className="field-label">WEIGHT</div>
      <div className="seg">
        <button
          type="button"
          className={`seg-btn ${byFeel ? "" : "seg-on"}`}
          onClick={() => setByFeel(false)}
        >
          PER SET
        </button>
        <button
          type="button"
          className={`seg-btn ${byFeel ? "seg-on" : ""}`}
          onClick={() => setByFeel(true)}
        >
          BY FEEL
        </button>
      </div>

      {byFeel ? (
        <div className="microcopy">
          No weight prescribed — the app will suggest one from your history when
          you train. Warmups can still be marked below.
        </div>
      ) : (
        sets.length > 1 && (
          <button type="button" className="btn btn-ghost" onClick={matchAll}>
            Make every set {toDisplay(sets[0]!.loadKg, unit)} {unit}
          </button>
        )
      )}

      <ol className="scheme-list">
        {sets.map((s, i) => (
          <li className="scheme-row" key={i}>
            <div className="scheme-row-head">
              <span className="scheme-n">SET {i + 1}</span>
              <button
                type="button"
                className={`chip ${s.warmup ? "chip-on" : ""}`}
                aria-pressed={s.warmup}
                onClick={() => patch(i, { warmup: !s.warmup })}
              >
                {s.warmup ? "WARMUP" : "WORKING"}
              </button>
            </div>
            {!byFeel && (
              <Stepper
                label={`set ${i + 1} load`}
                compact
                display={`${toDisplay(s.loadKg, unit)} ${unit}`}
                subText={formatStoredTwin(s.loadKg, unit)}
                value={s.loadKg}
                min={0.5}
                max={999}
                onChange={(v) => patch(i, { loadKg: v })}
                steps={[
                  { label: "−", delta: -stepKg(unit, false) },
                  { label: "+", delta: stepKg(unit, false) },
                ]}
              />
            )}
          </li>
        ))}
      </ol>

      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => onSave(groups)}
      >
        {busy
          ? "Adding…"
          : `Add ${sets.length} ${sets.length === 1 ? "set" : "sets"}`}
      </button>
      {groups.length > 1 && (
        <div className="microcopy">
          Saved as {groups.length} entries because the weight or type changes
          between sets. They run as one ramp.
        </div>
      )}
    </Sheet>
  );
}
