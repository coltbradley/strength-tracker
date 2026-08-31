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
import { formatClock, formatStoredTwin } from "../lib/format";
import { stepKg, toDisplay, type Unit } from "../lib/units";
import { getDefaultRestSeconds } from "../lib/settings";
import type { SetType } from "../lib/types";

/** One prescription row to be written: N identical sets at one load. */
export interface SetGroup {
  sets: number;
  reps_min: number;
  reps_max: number;
  load_kg: number | null;
  set_type: SetType;
  rest_seconds: number;
}

/**
 * A starting weight that is a round number in the unit the person is LOOKING
 * at. The device fallback is 20 kg, which is a clean default in kg mode and
 * reads as "44.1 lb" in lb mode — a number nobody has ever loaded on a bar.
 * Snapping to the display unit's own step turns that into 45 lb, and leaves kg
 * mode exactly where it was.
 */
export function snapToUnit(kg: number, unit: Unit): number {
  const step = stepKg(unit, false);
  if (!(step > 0)) return kg;
  return Math.max(step, Math.round(kg / step) * step);
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
  reps: number,
  byFeel: boolean,
  restSeconds: number,
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
    // reps_min === reps_max: authoring in the app is one number. The RANGE
    // still exists in the schema and the row editor, because a coach writing
    // "8-12" means it — but nobody sitting down to plan their own session
    // thinks in ranges, and asking for two numbers to get one was friction
    // for every single exercise.
    out.push({
      sets: 1,
      reps_min: reps,
      reps_max: reps,
      load_kg: load,
      set_type: type,
      rest_seconds: restSeconds,
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
  // Snapped once, at mount, so every stepper and the "make every set X"
  // shortcut start from the same round number.
  const [start] = useState(() => snapToUnit(startKg, unit));
  const [sets, setSets] = useState<PlannedSet[]>(() =>
    Array.from({ length: 3 }, () => ({ loadKg: start, warmup: false })),
  );
  const [reps, setReps] = useState(8);
  // Rest between sets. Seeded from the device default so the common case is
  // already right, and always written: the person filling this in IS the coach
  // here, so what they picked is a real prescription, not a missing one.
  const [rest, setRest] = useState(() => getDefaultRestSeconds());
  // "By feel" is a real prescription, not a missing one — the coach saying
  // "work up to something hard". Keeping it here means the weight steppers can
  // stay simple numbers instead of each carrying an empty state.
  const [byFeel, setByFeel] = useState(false);

  /** Growing copies the last set, which is what "one more set" means. */
  const resize = (n: number) => {
    setSets((prev) => {
      if (n <= prev.length) return prev.slice(0, Math.max(1, n));
      const last = prev[prev.length - 1] ?? { loadKg: start, warmup: false };
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

  const groups = groupSets(sets, reps, byFeel, rest);
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

      <div className="field-label">REPS PER SET</div>
      <Stepper
        label="reps"
        display={`${reps} ${reps === 1 ? "rep" : "reps"}`}
        value={reps}
        min={1}
        max={100}
        onChange={(v) => setReps(Math.round(v))}
        steps={[
          { label: "−", delta: -1 },
          { label: "+", delta: 1 },
        ]}
      />

      <div className="field-label">REST BETWEEN SETS</div>
      <Stepper
        label="rest"
        display={formatClock(rest)}
        subText={rest === 0 ? "no rest" : undefined}
        value={rest}
        min={0}
        max={3600}
        onChange={(v) => setRest(Math.round(v))}
        steps={[
          { label: "−30s", delta: -30 },
          { label: "+30s", delta: 30 },
        ]}
      />

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
