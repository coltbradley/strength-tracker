// Plan editor: everything about a future (or past) planned workout is
// editable here — the calendar date, the user's own pre-workout note, the
// week order, and the prescriptions themselves. Writes are online-only
// (planning happens at home); each action saves immediately and confirms
// with a toast so there is never an unsaved-state question.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { Note } from "../components/Note";
import {
  addPrescription,
  deletePlannedWorkout,
  deletePrescription,
  duplicatePlannedWorkout,
  getExercises,
  getPlannedWorkouts,
  getResolvedPrescriptions,
  swapWorkoutOrder,
  updatePlannedWorkout,
  updatePrescription,
  weekOrder,
  type WorkoutList,
} from "../lib/data";
import { reportError, toast } from "../lib/errors";
import {
  formatClock,
  formatPlannedDate,
  formatRepRange,
  todayLocalIso,
} from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import { kgToLb, stepKg, toDisplay } from "../lib/units";
import type {
  ExerciseRow,
  PlannedWorkoutRow,
  PrescriptionPatch,
  ResolvedPrescriptionRow,
} from "../lib/types";

type LoadMode = "kg" | "pct" | "feel";

interface RxDraft {
  sets: number;
  reps_min: number;
  reps_max: number;
  mode: LoadMode;
  load_kg: number; // stored kg, meaningful in kg mode
  load_pct: number; // meaningful in pct mode
  rest_seconds: number;
  hasRest: boolean;
  /** 0 = not in a superset; 1-4 = group A-D */
  superset: number;
}

function draftFrom(r: ResolvedPrescriptionRow): RxDraft {
  return {
    sets: r.sets,
    reps_min: r.reps_min,
    reps_max: r.reps_max,
    mode: r.load_kg !== null ? "kg" : r.load_pct_tm !== null ? "pct" : "feel",
    load_kg: r.load_kg ?? r.resolved_load_kg ?? 20,
    load_pct: r.load_pct_tm ?? 75,
    rest_seconds: r.rest_seconds ?? 180,
    hasRest: r.rest_seconds !== null,
    superset: r.superset_group ?? 0,
  };
}

function patchFrom(d: RxDraft): PrescriptionPatch {
  return {
    sets: d.sets,
    reps_min: d.reps_min,
    reps_max: Math.max(d.reps_min, d.reps_max),
    load_kg: d.mode === "kg" ? Math.max(0.5, d.load_kg) : null,
    load_pct_tm: d.mode === "pct" ? d.load_pct : null,
    rest_seconds: d.hasRest ? d.rest_seconds : null,
    superset_group: d.superset === 0 ? null : d.superset,
  };
}

const SUPERSET_CHOICES: [number, string][] = [
  [0, "NONE"],
  [1, "A"],
  [2, "B"],
  [3, "C"],
  [4, "D"],
];

export function Plan() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const unit = useUnit();

  const [list, setList] = useState<WorkoutList | null>(null);
  const [rx, setRx] = useState<ResolvedPrescriptionRow[] | null>(null);
  // local mirror of the date input: iOS fires change per picker-wheel tick,
  // so the write commits on blur (picker close), not per tick
  const [dateValue, setDateValue] = useState<string>("");
  const [dateDirty, setDateDirty] = useState(false);
  const [planNote, setPlanNote] = useState("");
  const [noteDirty, setNoteDirty] = useState(false);
  const [editingRx, setEditingRx] = useState<string | null>(null);
  const [draft, setDraft] = useState<RxDraft | null>(null);
  const [confirming, setConfirming] = useArmed(); // destructive action key
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [allExercises, setAllExercises] = useState<ExerciseRow[]>([]);
  const [duplicateDate, setDuplicateDate] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const workout: PlannedWorkoutRow | null =
    list?.workouts.find((w) => w.id === id) ?? null;
  // same order as the Today list, so "earlier/later" swaps with the row the
  // user actually sees next to this one
  const siblings = useMemo(
    () =>
      workout
        ? (list?.workouts ?? [])
            .filter((w) => w.program_id === workout.program_id)
            .sort(weekOrder)
        : [],
    [list, workout],
  );

  const reload = useCallback(() => {
    getPlannedWorkouts()
      .then((r) => setList(r.data))
      .catch((e: unknown) => reportError(e, "load plan"));
    if (id)
      getResolvedPrescriptions(id)
        .then((r) => setRx(r.data))
        .catch((e: unknown) => reportError(e, "load prescriptions"));
  }, [id]);

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    if (workout && !noteDirty) setPlanNote(workout.plan_note ?? "");
    if (workout && !dateDirty) setDateValue(workout.scheduled_date ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workout?.id, workout?.plan_note, workout?.scheduled_date]);

  useEffect(() => {
    if (!searchOpen || allExercises.length > 0) return;
    getExercises()
      .then((r) => setAllExercises(r.data))
      .catch((e: unknown) => reportError(e, "load exercises"));
  }, [searchOpen, allExercises.length]);

  if (!id) return null;
  if (!list) return <div className="screen muted">Loading…</div>;
  if (!workout)
    return (
      <div className="screen">
        <p className="muted">This workout no longer exists.</p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => navigate("/")}
        >
          Back to Today
        </button>
      </div>
    );

  const run = async (what: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      reportError(e, what);
    } finally {
      setBusy(false);
    }
  };

  const saveDate = (value: string) =>
    void run("save date", async () => {
      if ((workout.scheduled_date ?? "") === value) {
        setDateDirty(false);
        return;
      }
      await updatePlannedWorkout(workout.id, {
        scheduled_date: value === "" ? null : value,
      });
      setDateDirty(false);
      toast(
        value === ""
          ? "Date cleared"
          : `Scheduled for ${formatPlannedDate(value)}`,
      );
      reload();
    });

  const saveNote = () =>
    void run("save plan note", async () => {
      const trimmed = planNote.trim();
      await updatePlannedWorkout(workout.id, {
        plan_note: trimmed === "" ? null : trimmed,
      });
      setNoteDirty(false);
      toast("Plan note saved");
      reload();
    });

  const move = (dir: -1 | 1) => {
    const i = siblings.findIndex((w) => w.id === workout.id);
    const other = siblings[i + dir];
    if (!other) return;
    void run("reorder", async () => {
      await swapWorkoutOrder(workout, other);
      toast("Order updated");
      reload();
    });
  };

  const duplicate = () =>
    void run("duplicate workout", async () => {
      await duplicatePlannedWorkout(workout, duplicateDate || null);
      toast(
        duplicateDate
          ? `Copied to ${formatPlannedDate(duplicateDate)}`
          : "Copied (unscheduled)",
      );
      setDuplicateDate("");
      reload();
    });

  const removeWorkout = () =>
    void run("delete workout", async () => {
      await deletePlannedWorkout(workout.id);
      toast("Workout deleted");
      navigate("/");
    });

  const saveRx = (r: ResolvedPrescriptionRow) => {
    if (!draft) return;
    void run("save exercise", async () => {
      await updatePrescription(r.id, workout.id, patchFrom(draft));
      setEditingRx(null);
      setDraft(null);
      toast("Exercise updated");
      reload();
    });
  };

  const removeRx = (r: ResolvedPrescriptionRow) =>
    void run("remove exercise", async () => {
      await deletePrescription(r.id, workout.id);
      setConfirming(null);
      setEditingRx(null);
      toast(`${r.exercise_name} removed`);
      reload();
    });

  const addExercise = (ex: ExerciseRow) =>
    void run("add exercise", async () => {
      await addPrescription(workout.id, ex.id, rx ?? []);
      setSearchOpen(false);
      setSearch("");
      toast(`${ex.name} added`);
      reload();
    });

  const filtered = allExercises
    .filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 30);

  const idx = siblings.findIndex((w) => w.id === workout.id);
  const isToday = workout.scheduled_date === todayLocalIso();

  return (
    <div className="screen">
      <button type="button" className="back-link" onClick={() => navigate("/")}>
        ‹ TODAY
      </button>
      <h2 className="screen-title">
        {workout.label ?? `Workout ${workout.day_index + 1}`}
      </h2>
      {workout.notes && <Note label="COACH" text={workout.notes} />}

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">EXERCISES</span>
          <span className="section-meta">{rx?.length ?? 0}</span>
        </div>
        {rx === null && <p className="muted">Loading…</p>}
        {(rx ?? []).map((r) => {
          const editing = editingRx === r.id && draft;
          return (
            <div key={r.id} className="week-item">
              <button
                type="button"
                className="week-row rx-edit-row"
                onClick={() => {
                  if (editingRx === r.id) {
                    setEditingRx(null);
                    setDraft(null);
                  } else {
                    setEditingRx(r.id);
                    setDraft(draftFrom(r));
                    setConfirming(null);
                  }
                }}
              >
                <span className="week-label">{r.exercise_name}</span>
                <span className="week-state">
                  {r.superset_group !== null
                    ? `${String.fromCharCode(64 + r.superset_group)} · `
                    : ""}
                  {r.sets} × {formatRepRange(r.reps_min, r.reps_max)}
                  {r.load_kg !== null
                    ? ` · ${toDisplay(r.load_kg, unit)} ${unit}`
                    : r.load_pct_tm !== null
                      ? ` · ${r.load_pct_tm}%`
                      : ""}
                </span>
                <span className="row-edit">
                  {editingRx === r.id ? "▾" : "EDIT"}
                </span>
              </button>
              {editing && draft && (
                <div className="week-detail">
                  <Stepper
                    label="sets"
                    field
                    title="SETS"
                    display={String(draft.sets)}
                    value={draft.sets}
                    min={1}
                    max={20}
                    onChange={(v) =>
                      setDraft({ ...draft, sets: Math.round(v) })
                    }
                    steps={[
                      { label: "−", delta: -1 },
                      { label: "+", delta: 1 },
                    ]}
                  />
                  <Stepper
                    label="reps min"
                    field
                    title="REPS · MIN"
                    display={String(draft.reps_min)}
                    value={draft.reps_min}
                    min={1}
                    max={100}
                    onChange={(v) =>
                      setDraft({ ...draft, reps_min: Math.round(v) })
                    }
                    steps={[
                      { label: "−", delta: -1 },
                      { label: "+", delta: 1 },
                    ]}
                  />
                  <Stepper
                    label="reps max"
                    field
                    title="REPS · MAX"
                    display={String(Math.max(draft.reps_min, draft.reps_max))}
                    value={Math.max(draft.reps_min, draft.reps_max)}
                    min={draft.reps_min}
                    max={100}
                    onChange={(v) =>
                      setDraft({ ...draft, reps_max: Math.round(v) })
                    }
                    steps={[
                      { label: "−", delta: -1 },
                      { label: "+", delta: 1 },
                    ]}
                  />

                  <div className="section-head">
                    <span className="field-label">LOAD</span>
                  </div>
                  <div className="seg seg-types">
                    {(
                      [
                        ["kg", unit.toUpperCase()],
                        ["pct", "% TM"],
                        ["feel", "BY FEEL"],
                      ] as [LoadMode, string][]
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        className={`seg-btn ${draft.mode === mode ? "seg-on" : ""}`}
                        onClick={() => setDraft({ ...draft, mode })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {draft.mode === "kg" && (
                    <Stepper
                      label="load"
                      field
                      title={`LOAD · ${unit.toUpperCase()}`}
                      display={String(toDisplay(draft.load_kg, unit))}
                      subText={
                        unit === "lb"
                          ? `${Math.round(draft.load_kg * 10) / 10} kg stored`
                          : `${Math.round(kgToLb(draft.load_kg) * 10) / 10} lb`
                      }
                      value={draft.load_kg}
                      min={0.5}
                      max={999}
                      onChange={(v) => setDraft({ ...draft, load_kg: v })}
                      steps={[
                        { label: "−", delta: -stepKg(unit, false) },
                        { label: "+", delta: stepKg(unit, false) },
                      ]}
                    />
                  )}
                  {draft.mode === "pct" && (
                    <Stepper
                      label="percent of training max"
                      field
                      title="LOAD · % TM"
                      display={`${draft.load_pct}%`}
                      value={draft.load_pct}
                      min={2.5}
                      max={200}
                      onChange={(v) => setDraft({ ...draft, load_pct: v })}
                      steps={[
                        { label: "−", delta: -2.5 },
                        { label: "+", delta: 2.5 },
                      ]}
                    />
                  )}

  {/* exercises sharing a letter run together as a superset (A1/A2) */}
                  <div className="section-head">
                    <span className="field-label">SUPERSET</span>
                  </div>
                  <div className="seg seg-types">
                    {SUPERSET_CHOICES.map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={`seg-btn ${draft.superset === value ? "seg-on" : ""}`}
                        onClick={() => setDraft({ ...draft, superset: value })}
                      >
                        {label === "NONE" ? "None" : label}
                      </button>
                    ))}
                  </div>

                  <div className="section-head">
                    <span className="field-label">REST</span>
                  </div>
                  <div className="seg seg-types">
                    <button
                      type="button"
                      className={`seg-btn ${draft.hasRest ? "seg-on" : ""}`}
                      onClick={() => setDraft({ ...draft, hasRest: true })}
                    >
                      TIMED REST
                    </button>
                    <button
                      type="button"
                      className={`seg-btn ${!draft.hasRest ? "seg-on" : ""}`}
                      onClick={() => setDraft({ ...draft, hasRest: false })}
                    >
                      NO TARGET
                    </button>
                  </div>
                  {draft.hasRest && (
                    <Stepper
                      label="rest seconds"
                      field
                      title="REST · MIN:SEC"
                      display={formatClock(draft.rest_seconds)}
                      value={draft.rest_seconds}
                      min={0}
                      max={3600}
                      onChange={(v) =>
                        setDraft({ ...draft, rest_seconds: Math.round(v) })
                      }
                      steps={[
                        { label: "−", delta: -15 },
                        { label: "+", delta: 15 },
                      ]}
                    />
                  )}

                  <div className="detail-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy}
                      onClick={() => saveRx(r)}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setEditingRx(null);
                        setDraft(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={`btn ${confirming === `rx:${r.id}` ? "btn-danger" : "btn-ghost"}`}
                      disabled={busy}
                      onClick={() =>
                        confirming === `rx:${r.id}`
                          ? removeRx(r)
                          : setConfirming(`rx:${r.id}`)
                      }
                    >
                      {confirming === `rx:${r.id}` ? "Remove?" : "Remove"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="btn btn-outline-ink btn-block"
          onClick={() => setSearchOpen(true)}
        >
          Add exercise
        </button>
      </section>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">SCHEDULED DAY</span>
          {isToday && <span className="section-meta">TODAY</span>}
        </div>
        <div className="date-row">
          <input
            className="input date-input"
            type="date"
            value={dateValue}
            onChange={(e) => {
              setDateValue(e.target.value);
              setDateDirty(true);
            }}
            onBlur={() => dateDirty && saveDate(dateValue)}
          />
          {!isToday && (
            <button
              type="button"
              className="chip"
              disabled={busy}
              onClick={() => {
                setDateValue(todayLocalIso());
                saveDate(todayLocalIso());
              }}
            >
              Today
            </button>
          )}
        </div>
        <div className="microcopy">Start unlocks on the scheduled day.</div>
        <div className="chip-row">
          <button
            type="button"
            className="chip"
            disabled={idx <= 0 || busy}
            onClick={() => move(-1)}
          >
            ↑ Earlier
          </button>
          <button
            type="button"
            className="chip"
            disabled={idx < 0 || idx >= siblings.length - 1 || busy}
            onClick={() => move(1)}
          >
            ↓ Later
          </button>
        </div>
      </section>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">PLAN NOTE</span>
          {noteDirty && <span className="section-meta">UNSAVED</span>}
        </div>
        <textarea
          className="input note-input"
          placeholder="What's the intent for this one? Cues, targets, context…"
          rows={3}
          value={planNote}
          onChange={(e) => {
            setPlanNote(e.target.value);
            setNoteDirty(true);
          }}
          onBlur={() => noteDirty && saveNote()}
        />
        <div className="microcopy">Saved automatically.</div>
      </section>

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">DUPLICATE TO ANOTHER DAY</span>
        </div>
        <div className="date-row">
          <input
            className="input date-input"
            type="date"
            value={duplicateDate}
            onChange={(e) => setDuplicateDate(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={duplicate}
          >
            Duplicate
          </button>
        </div>
        <div className="microcopy">
          Copies this workout and its exercises onto the chosen day. Leave the
          date empty to copy it unscheduled.
        </div>
      </section>

      <section className="rule-section">
        <button
          type="button"
          className={`btn btn-block ${confirming === "workout" ? "btn-danger" : "btn-ghost"}`}
          disabled={busy}
          onClick={() =>
            confirming === "workout"
              ? removeWorkout()
              : setConfirming("workout")
          }
        >
          {confirming === "workout" ? "Delete workout?" : "Delete workout"}
        </button>
        {confirming === "workout" && (
          <div className="microcopy">
            Removes the planned day and its exercises. Logged sessions are not
            touched. Prefer Skip if it just isn’t happening this week.
          </div>
        )}
      </section>

      {searchOpen && (
        <div className="sheet-backdrop" onClick={() => setSearchOpen(false)}>
          <div
            className="sheet sheet-tall"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-head">
              <span className="sheet-title">
                ADD EXERCISE
                {allExercises.length > 0
                  ? ` · ${allExercises.length} IN LIBRARY`
                  : ""}
              </span>
              <button
                type="button"
                className="sheet-close"
                onClick={() => setSearchOpen(false)}
              >
                CANCEL
              </button>
            </div>
            <input
              className="input"
              placeholder="Search exercises…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
            <div className="search-results">
              {filtered.map((ex) => (
                <button
                  key={ex.id}
                  type="button"
                  className="drawer-row"
                  onClick={() => addExercise(ex)}
                >
                  <span className="drawer-name">{ex.name}</span>
                  <span className="drawer-tag">
                    {ex.equipment ? ex.equipment.toUpperCase() : ""}
                  </span>
                </button>
              ))}
              {allExercises.length === 0 && (
                <p className="muted">Loading exercise list…</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
