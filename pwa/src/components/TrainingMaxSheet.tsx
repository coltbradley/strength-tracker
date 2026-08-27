// Training maxes: the app's one place to see and set them.
//
// WHY IT LIVES BEHIND SETTINGS. The plan editor offers a "% TM" load mode, so
// the app can author a prescription it cannot resolve — that renders "NO TM
// SET" on Today and in the session with, until now, no in-app remedy. The
// badge is where the problem is FELT, but Today's one primary action is Start
// (hierarchy round, docs/decisions.md 2026-08-26) and a second tappable
// control above the fold there is exactly what that round removed. So the
// badge stays a statement of fact and the remedy lives one gear-tap away,
// reachable from every screen — and this sheet leads with NEEDED BY THE PLAN,
// which names the lifts behind the badge so the trip is one hop, not a hunt.
//
// The table is HISTORY-carrying: (user, exercise, effective_date) is unique
// and the latest date not in the future wins. A new value is a NEW DATED ROW,
// never an overwrite, and every row stays visible so the progression reads
// back. Re-setting a date already used replaces that one row — corrections
// are legitimate on `training_maxes` (RLS grants update and delete), unlike
// on `sets`.
//
// Writes go straight to Supabase with a toast, not through the offline
// outbox: `training_maxes` is neither one of the four PWA-only tables nor
// session-critical, so it is the plan editor's write class, not the set
// logger's.

import { useEffect, useState } from "react";
import { NumberPad, type PadRequest } from "./NumberPad";
import { Sheet } from "./Sheet";
import { ExercisePicker } from "./ExercisePicker";
import {
  currentTrainingMax,
  deleteTrainingMax,
  getExercises,
  getTrainingMaxes,
  getUnresolvedTmExercises,
  groupTrainingMaxes,
  setTrainingMax,
} from "../lib/data";
import { reportError, toast } from "../lib/errors";
import { formatPlannedDate, todayLocalIso } from "../lib/format";
import { useArmed } from "../hooks/useArmed";
import { useUnit } from "../hooks/useUnit";
import { fromDisplay, toDisplay } from "../lib/units";
import type { ExerciseRow, TrainingMaxRow } from "../lib/types";

/** A training max is a working number, not a world record; anything outside
 *  this is a typo (a slipped decimal or lb typed into a kg field). */
const MAX_TM_KG = 600;

export function TrainingMaxSheet({ onClose }: { onClose: () => void }) {
  const unit = useUnit();
  const [rows, setRows] = useState<TrainingMaxRow[]>([]);
  const [exercises, setExercises] = useState<ExerciseRow[]>([]);
  const [needed, setNeeded] = useState<
    { exercise_id: string; exercise_name: string }[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const [effective, setEffective] = useState(todayLocalIso());
  const [pad, setPad] = useState<PadRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [armed, setArmed] = useArmed();
  const [reloadTick, setReloadTick] = useState(0);
  /** a TM write changed what % TM prescriptions resolve to — see `close` */
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getTrainingMaxes()
      .then((r) => {
        if (cancelled) return;
        setRows(r.data);
        setFromCache(r.fromCache);
      })
      .catch((e: unknown) => reportError(e, "load training maxes"))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    getExercises()
      .then((r) => {
        if (!cancelled) setExercises(r.data);
      })
      .catch((e: unknown) => reportError(e, "load exercises"));
    // best effort: the plan may be unreachable offline, and the rest of the
    // sheet still works without this section
    getUnresolvedTmExercises()
      .then((r) => {
        if (!cancelled) setNeeded(r);
      })
      .catch(() => setNeeded([]));
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  /**
   * A training max is an input to `v_resolved_prescriptions`, so setting one
   * changes what Today and the open session render — and those screens hold
   * their resolved prescriptions in component state. Every other cross-screen
   * invalidation in this app rides on a route change remounting the screen
   * (History's void, the plan editor's edits); a settings sheet floats OVER
   * the current route and never gets one, so the badge that sent the user
   * here would still read "NO TM SET" when they closed this. The write caches
   * are already cleared, so this reload is only about the screen behind: it
   * costs a repaint, keeps the route, and IndexedDB holds the outbox, the
   * active session and the rest timer across it by design.
   */
  const close = () => {
    if (dirty) window.location.reload();
    else onClose();
  };

  const today = todayLocalIso();
  const names = new Map(exercises.map((e) => [e.id, e.name]));
  const byExercise = groupTrainingMaxes(rows);
  const exerciseIds = [...byExercise.keys()].sort((a, b) =>
    (names.get(a) ?? a).localeCompare(names.get(b) ?? b),
  );
  const stillNeeded = needed.filter((n) => {
    const list = byExercise.get(n.exercise_id) ?? [];
    return currentTrainingMax(list, today) === null;
  });

  const write = (exerciseId: string, displayValue: number) => {
    const kg = fromDisplay(displayValue, unit);
    if (!(kg > 0) || kg > MAX_TM_KG) {
      toast(
        `Training max must be between 0 and ${toDisplay(MAX_TM_KG, unit)} ${unit}`,
        "error",
      );
      return;
    }
    setTrainingMax(exerciseId, Math.round(kg * 100) / 100, effective)
      .then(() => {
        toast(
          `${names.get(exerciseId) ?? exerciseId} training max ${toDisplay(kg, unit)} ${unit} from ${formatPlannedDate(effective)}`,
        );
        setDirty(true);
        setReloadTick((t) => t + 1);
      })
      .catch((e: unknown) => reportError(e, "save training max"));
  };

  const openPadFor = (exerciseId: string) => {
    const list = byExercise.get(exerciseId) ?? [];
    const cur = currentTrainingMax(list, today);
    setPad({
      label: `${(names.get(exerciseId) ?? exerciseId).toUpperCase()} · TM IN ${unit.toUpperCase()}`,
      action: "SET TM",
      initial: cur === null ? "" : String(toDisplay(cur.value_kg, unit)),
      allowDecimal: true,
      onCommit: (v) => {
        setPad(null);
        write(exerciseId, v);
      },
      onCancel: () => setPad(null),
    });
  };

  const remove = (row: TrainingMaxRow) => {
    deleteTrainingMax(row.id)
      .then(() => {
        setArmed(null);
        toast("Training max entry removed");
        setDirty(true);
        setReloadTick((t) => t + 1);
      })
      .catch((e: unknown) => reportError(e, "remove training max"));
  };

  return (
    <Sheet title="TRAINING MAXES" onClose={close}>
      <div className="microcopy">
        The number a “% TM” prescription resolves against. Each value is dated:
        the most recent date on or before today is the one the plan uses, and
        the older rows stay as the progression. Stored on the server, so Claude
        reads the same numbers.
      </div>

      {fromCache && (
        <div className="cache-note">offline — showing cached values</div>
      )}

      <section className="settings-group">
        <div className="field-label">EFFECTIVE FROM</div>
        <div className="date-row">
          <input
            className="input date-input"
            type="date"
            aria-label="effective date for the next training max"
            value={effective}
            onChange={(e) => setEffective(e.target.value || today)}
          />
          {effective !== today && (
            <button
              type="button"
              className="chip"
              onClick={() => setEffective(today)}
            >
              TODAY
            </button>
          )}
        </div>
        <div className="microcopy">
          The date the next value you set takes effect. A future date is
          scheduled, not current — the plan keeps using the older value until
          that day.
        </div>
      </section>

      {stillNeeded.length > 0 && (
        <section className="settings-group">
          <div className="field-label">NEEDED BY THE PLAN</div>
          {stillNeeded.map((n) => (
            <button
              key={n.exercise_id}
              type="button"
              className="sheet-row sheet-row-btn"
              onClick={() => openPadFor(n.exercise_id)}
            >
              <span>{n.exercise_name}</span>
              <span className="sheet-row-value">NO TM SET</span>
            </button>
          ))}
          <div className="microcopy">
            These lifts are prescribed as a percentage of a training max that
            does not exist yet, so they show no load anywhere in the app.
          </div>
        </section>
      )}

      <section className="settings-group">
        <div className="field-label">BY LIFT</div>

        {loading && rows.length === 0 && <p className="muted">Loading…</p>}
        {!loading && exerciseIds.length === 0 && (
          <p className="muted">
            None set. Add one below, or ask Claude to set it from a
            conversation.
          </p>
        )}

        {exerciseIds.map((exerciseId) => {
          const list = byExercise.get(exerciseId) ?? [];
          const cur = currentTrainingMax(list, today);
          // The value in force is the headline; the rows beneath are the ones
          // it replaced (and any dated ahead of today). Listing the current
          // row again under its own headline was just the same number twice.
          const rest = list.filter((r) => r.id !== cur?.id);
          return (
            <div key={exerciseId} className="sheet-row sheet-row-stack">
              <button
                type="button"
                className="sheet-row sheet-row-btn"
                onClick={() => openPadFor(exerciseId)}
              >
                <span>
                  {names.get(exerciseId) ?? exerciseId}{" "}
                  <span className="muted-mono">
                    {cur === null
                      ? "· tap to type"
                      : `· ${formatPlannedDate(cur.effective_date)}`}
                  </span>
                </span>
                <span className="sheet-row-value">
                  {cur === null
                    ? "NOT IN FORCE"
                    : `${toDisplay(cur.value_kg, unit)}\u00a0${unit}`}
                </span>
              </button>
              {/* No REMOVE on the value in force: re-setting the same date
                  replaces it, and a value dated wrongly becomes superseded by
                  the corrected one and is removable from here. Every mistake
                  has a route out without a delete on the live number. */}
              {rest.map((r) => (
                <div key={r.id} className="sheet-row override-row">
                  <span className="muted-mono">
                    {`${toDisplay(r.value_kg, unit)}\u00a0${unit}`} ·{" "}
                    {formatPlannedDate(r.effective_date)}
                    {r.effective_date > today ? " · SCHEDULED" : ""}
                  </span>
                  <button
                    type="button"
                    className={`drawer-action ${armed === r.id ? "drawer-action-armed" : ""}`}
                    aria-label={
                      armed === r.id
                        ? "confirm remove training max entry"
                        : "remove training max entry"
                    }
                    onClick={() =>
                      armed === r.id ? remove(r) : setArmed(r.id)
                    }
                  >
                    {armed === r.id ? "REMOVE?" : "REMOVE"}
                  </button>
                </div>
              ))}
            </div>
          );
        })}

        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() => setPickerOpen(true)}
        >
          Set a training max
        </button>
      </section>

      {pickerOpen && (
        <ExercisePicker
          title="TRAINING MAX"
          exercises={exercises}
          badge={(ex) => (byExercise.has(ex.id) ? "HAS TM" : null)}
          preferBadged
          onPick={(ex) => {
            setPickerOpen(false);
            openPadFor(ex.id);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {pad && <NumberPad req={pad} />}
    </Sheet>
  );
}
