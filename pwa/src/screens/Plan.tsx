// Plan editor: everything about a future (or past) planned workout is
// editable here — the calendar date, the user's own pre-workout note, the
// week order, and the prescriptions themselves. Writes are online-only
// (planning happens at home); each action saves immediately and confirms
// with a toast so there is never an unsaved-state question.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Stepper } from "../components/Stepper";
import { getSetting } from "../lib/settings";
import {
  SetSchemeSheet,
  type SetGroup,
} from "../components/SetSchemeSheet";
import { Note } from "../components/Note";
import {
  addPrescriptionGroups,
  saveWorkoutAsTemplate,
  deletePlannedWorkout,
  deletePrescription,
  duplicatePlannedWorkout,
  getExercises,
  getPlannedWorkouts,
  getResolvedPrescriptions,
  movePrescription,
  swapWorkoutOrder,
  updatePlannedWorkout,
  updatePrescription,
  weekOrder,
  type WorkoutList,
} from "../lib/data";
import { reportError, toast } from "../lib/errors";
import {
  formatPlannedDate,
  formatRepRange,
  formatStoredTwin,
  todayLocalIso,
  workoutName,
} from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import { useArmed } from "../hooks/useArmed";
import { ExercisePicker } from "../components/ExercisePicker";
import { stepKg, toDisplay } from "../lib/units";
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

/**
 * Whether row `i` runs as a ramp with the row beside it — consecutive
 * prescriptions naming the SAME exercise. Today renders those as one grouped
 * entry ("1×8 @60 · 1×6 @85 · 3×3 @112"), which is how a warmup ramp is
 * expressed; this editor keeps them as separate rows so each is editable. The
 * marker exists so the two screens visibly agree.
 */
function rampWith(rows: ResolvedPrescriptionRow[], i: number): boolean {
  const id = rows[i]?.exercise_id;
  if (id === undefined) return false;
  return rows[i - 1]?.exercise_id === id || rows[i + 1]?.exercise_id === id;
}

/**
 * Where row `i` sits in its superset run. A superset was rendered as a bare
 * "A · " prefix on each row, which says the pairing exists without showing
 * WHICH rows are paired — the one thing that actually changes how the session
 * is performed. Rows in a group now share a left rail and the run is labelled
 * once at its top, so a pair reads as a pair.
 */
function supersetAt(
  rows: ResolvedPrescriptionRow[],
  i: number,
): { group: number; first: boolean; last: boolean } | null {
  const g = rows[i]?.superset_group ?? null;
  if (g === null) return null;
  return {
    group: g,
    first: (rows[i - 1]?.superset_group ?? null) !== g,
    last: (rows[i + 1]?.superset_group ?? null) !== g,
  };
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
  /** Exercise chosen in the picker, awaiting its set scheme. */
  const [adding, setAdding] = useState<ExerciseRow | null>(null);
  /** null = not saving; a string = the name being typed */
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [allExercises, setAllExercises] = useState<ExerciseRow[]>([]);
  const [exercisesFailed, setExercisesFailed] = useState(false);
  const [duplicateDate, setDuplicateDate] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [labelValue, setLabelValue] = useState("");
  const [labelDirty, setLabelDirty] = useState(false);
  /** Set by addExercise so the reload that follows can open the new row's
   *  editor. Adding an exercise and then having to hunt for it was the
   *  complaint; landing in its editor is the answer. */
  const openAfterReload = useRef<string | null>(null);

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
    if (workout && !labelDirty) setLabelValue(workout.label ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workout?.id,
    workout?.plan_note,
    workout?.scheduled_date,
    workout?.label,
  ]);

  // Open the editor on the exercise that was just added, and bring it into
  // view. Runs when the reload that follows the insert delivers the new row.
  useEffect(() => {
    const wanted = openAfterReload.current;
    if (wanted === null || rx === null) return;
    const row = rx.find((r) => r.id === wanted);
    if (row === undefined) return;
    openAfterReload.current = null;
    setEditingRx(row.id);
    setDraft(draftFrom(row));
    setConfirming(null);
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-rx="${row.id}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rx]);

  useEffect(() => {
    if (!searchOpen || allExercises.length > 0) return;
    setExercisesFailed(false);
    getExercises()
      .then((r) => setAllExercises(r.data))
      .catch((e: unknown) => {
        // the picker says so itself now instead of spinning forever
        setExercisesFailed(true);
        reportError(e, "load exercises");
      });
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

  /**
   * A starting weight for the scheme sheet's steppers. An existing row for the
   * same exercise in this day wins — that is the ramp case, where the next
   * set-group is almost always near the last one. Otherwise the device's
   * fallback load, which is what the session screen would suggest anyway.
   */
  const startKgFor = (exerciseId: string): number => {
    const mine = (rx ?? []).filter((r) => r.exercise_id === exerciseId);
    const last = mine[mine.length - 1];
    return last?.resolved_load_kg ?? getSetting("fallbackLoad")[unit];
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

  /**
   * Picking an exercise no longer writes a row. It opens the set scheme sheet,
   * which asks how many sets, what each weighs and which are warmups — the
   * three things a workout is actually made of. The old path dropped a bare
   * 3x8-by-feel row into the day and left you to find the editor.
   */
  const saveScheme = (ex: ExerciseRow, groups: SetGroup[]) =>
    void run("add exercise", async () => {
      // Consecutive prescriptions for the SAME exercise are a ramp: Today
      // renders them as one grouped entry ("3×5 · 3×3"), while this editor
      // keeps them as separate rows. That is deliberate — it is how a warmup
      // ramp is expressed — but it happened silently, so the two screens
      // appeared to disagree. Say it out loud instead.
      const last = (rx ?? [])[(rx ?? []).length - 1];
      const startsRamp = last !== undefined && last.exercise_id === ex.id;

      const newId = await addPrescriptionGroups(
        workout.id,
        ex.id,
        groups,
        rx ?? [],
      );
      // Only auto-expand a single-row add. A ramp is already fully specified
      // by the sheet; opening its first row would suggest it is not.
      if (groups.length === 1) openAfterReload.current = newId;
      setAdding(null);
      const total = groups.reduce((n, g) => n + g.sets, 0);
      toast(
        startsRamp
          ? `${ex.name} added — it joins the ramp above it`
          : `${ex.name}: ${total} ${total === 1 ? "set" : "sets"} added`,
      );
      reload();
    });

  const moveRx = (r: ResolvedPrescriptionRow, dir: -1 | 1) =>
    void run("reorder exercise", async () => {
      await movePrescription(r.id, workout.id, dir, rx ?? []);
      reload();
    });

  const saveTemplate = () =>
    void run("save template", async () => {
      const name = (templateName ?? "").trim() || workoutName(workout);
      await saveWorkoutAsTemplate(workout, name, rx ?? []);
      setTemplateName(null);
      toast(`Saved "${name}" — add it to any day from Today`);
    });

  const saveLabel = () =>
    void run("rename workout", async () => {
      const next = labelValue.trim();
      await updatePlannedWorkout(workout.id, {
        label: next.length === 0 ? null : next,
      });
      setLabelDirty(false);
      reload();
    });

  const idx = siblings.findIndex((w) => w.id === workout.id);
  const isToday = workout.scheduled_date === todayLocalIso();

  const loadDraftLabel =
    draft?.mode === "pct"
      ? `${draft.load_pct}% TM`
      : draft
        ? `${toDisplay(draft.load_kg, unit)} ${unit}`
        : "";

  return (
    <div className="screen">
      <button type="button" className="back-link" onClick={() => navigate("/")}>
        ‹ TODAY
      </button>
      <input
        className="input plan-title-input"
        value={labelValue}
        placeholder={workoutName(workout)}
        aria-label="workout name"
        onChange={(e) => {
          setLabelValue(e.target.value);
          setLabelDirty(true);
        }}
        onBlur={() => labelDirty && saveLabel()}
      />
      {workout.notes && <Note label="COACH" text={workout.notes} />}

      <section className="rule-section">
        <div className="section-head">
          <span className="field-label">EXERCISES</span>
          <span className="section-meta">{rx?.length ?? 0}</span>
        </div>
        {rx === null && <p className="muted">Loading…</p>}
        {(rx ?? []).map((r, i) => {
          const editing = editingRx === r.id && draft;
          const ss = supersetAt(rx ?? [], i);
          return (
            <div
              key={r.id}
              className={`week-item${ss ? " ss-member" : ""}${ss?.first ? " ss-first" : ""}${ss?.last ? " ss-last" : ""}`}
              data-rx={r.id}
            >
              {/* Labelled once, at the top of the run, instead of a letter
                  repeated on every row. "Superset A · 2 exercises" says what is
                  actually true; "A · " on two separate rows did not. */}
              {ss?.first && (
                <div className="ss-head">
                  SUPERSET {String.fromCharCode(64 + ss.group)}
                  <span className="ss-head-note">
                    {" · "}
                    {(rx ?? []).filter(
                      (o) => o.superset_group === ss.group,
                    ).length}{" "}
                    exercises, alternated
                  </span>
                </div>
              )}
              <button
                type="button"
                className="week-row week-row-rx"
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
                <span className="week-label">
                  {r.exercise_name}
                  {rampWith(rx ?? [], i) && (
                    <span className="rx-ramp"> · RAMP</span>
                  )}
                </span>
                <span className="week-state">
                  {/* Warmup is worth saying on the collapsed row: it is the
                      difference between "you owe 5 working sets" and 3. */}
                  {r.set_type !== undefined && r.set_type !== "working" && (
                    <span className="rx-type">
                      {r.set_type.toUpperCase()}
                    </span>
                  )}

                  {r.sets} × {formatRepRange(r.reps_min, r.reps_max)}
                  {r.load_kg !== null
                    ? ` · ${toDisplay(r.load_kg, unit)} ${unit}`
                    : r.load_pct_tm !== null
                      ? ` · ${r.load_pct_tm}%`
                      : ""}
                </span>
                <span className="chev">{editingRx === r.id ? "▾" : "▸"}</span>
              </button>
              {editing && draft && (
                <div className="week-detail">
                  <Stepper
                    label="sets"
                    compact
                    display={`${draft.sets} ${draft.sets === 1 ? "set" : "sets"}`}
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
                    compact
                    display={`${draft.reps_min} reps min`}
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
                    compact
                    display={`${Math.max(draft.reps_min, draft.reps_max)} reps max`}
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
                      compact
                      display={loadDraftLabel}
                      subText={formatStoredTwin(draft.load_kg, unit)}
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
                      compact
                      display={loadDraftLabel}
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
                      compact
                      display={`${draft.rest_seconds}s rest`}
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

                  {/* Order is part of the plan: an exercise added last used
                      to be stuck last, with nothing anywhere that writes
                      `position`. */}
                  <div className="section-head">
                    <span className="field-label">ORDER</span>
                    <span className="section-meta">
                      {i + 1} of {(rx ?? []).length}
                    </span>
                  </div>
                  <div className="chip-row">
                    <button
                      type="button"
                      className="chip"
                      disabled={i === 0 || busy}
                      onClick={() => moveRx(r, -1)}
                    >
                      ↑ Move up
                    </button>
                    <button
                      type="button"
                      className="chip"
                      disabled={i >= (rx ?? []).length - 1 || busy}
                      onClick={() => moveRx(r, 1)}
                    >
                      ↓ Move down
                    </button>
                  </div>

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
                    {/* DELETE, not Remove: this drops the prescription from
                        the database. Session's UNDO ADD is the reversible one. */}
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
                      {confirming === `rx:${r.id}`
                        ? "Delete exercise?"
                        : "Delete exercise"}
                    </button>
                  </div>
                  {confirming === `rx:${r.id}` && (
                    <div className="microcopy">
                      Removes this exercise from the planned day. Sets you have
                      already logged against it are not touched.
                    </div>
                  )}
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

        {/* The planning sequence had no end. You added exercises one at a time
            and then just... stopped, with no signal that the day was done or
            that any of it had saved. Everything below this point (date, note,
            duplicate, delete) is an adjustment, not a step, so the finishing
            action belongs here rather than at the very bottom of the screen. */}
        <button
          type="button"
          className="btn btn-primary btn-block plan-done"
          onClick={() => navigate("/")}
        >
          Done planning
        </button>
        <div className="microcopy">
          Everything here saves as you go. This just takes you back to Today.
        </div>
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
        {dateValue === "" ? (
          <div className="microcopy microcopy-warn">
            Not on the calendar. A day with no date does not appear on the week
            strip at all — pick one so this workout is findable.
          </div>
        ) : (
          <div className="microcopy">Start unlocks on the scheduled day.</div>
        )}
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
          <span className="field-label">SAVE AS TEMPLATE</span>
        </div>
        {templateName === null ? (
          <button
            type="button"
            className="btn btn-secondary btn-block"
            disabled={busy || (rx ?? []).length === 0}
            onClick={() => setTemplateName(workoutName(workout))}
          >
            Save this workout
          </button>
        ) : (
          <>
            <input
              className="input"
              value={templateName}
              aria-label="template name"
              placeholder="Push A"
              autoFocus
              onChange={(e) => setTemplateName(e.target.value)}
            />
            <div className="detail-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setTemplateName(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={saveTemplate}
              >
                Save
              </button>
            </div>
          </>
        )}
        <div className="microcopy">
          Keeps this workout to reuse on any day. When you add it, the weights
          come from the last time you actually did each exercise, not from
          today’s numbers.
        </div>
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
        <ExercisePicker
          title="ADD EXERCISE"
          exercises={allExercises}
          failed={exercisesFailed}
          onPick={(ex) => {
            setSearchOpen(false);
            setAdding(ex);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {adding && (
        <SetSchemeSheet
          exerciseName={adding.name}
          unit={unit}
          startKg={startKgFor(adding.id)}
          busy={busy}
          onCancel={() => setAdding(null)}
          onSave={(groups) => saveScheme(adding, groups)}
        />
      )}
    </div>
  );
}
