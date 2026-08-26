// Today: the confirmed program's week as a ruled list, chronological when
// workouts carry scheduled dates (DONE / SKIPPED / TODAY / MISSED / date),
// expandable to prescriptions + notes. Start is gated to today's workout;
// everything else is editable via the plan editor. Programs without dates
// fall back to the original inference: first unfinished day is TODAY.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getDoneWorkoutIds,
  getExercises,
  getLastActuals,
  getPlannedWorkouts,
  getResolvedPrescriptions,
  updatePlannedWorkout,
  weekOrder,
  type WorkoutList,
} from "../lib/data";
import { cacheGet, cacheSet, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
import { uuid } from "../lib/uuid";
import { reportError, toast } from "../lib/errors";
import {
  formatPlannedDate,
  formatRxTarget,
  formatTodayHeading,
  rxHasNoTm,
  todayLocalIso,
} from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import type {
  ActiveSession,
  PlannedWorkoutRow,
  ResolvedPrescriptionRow,
} from "../lib/types";

type WorkoutState =
  "DONE" | "SKIPPED" | "TODAY" | "MISSED" | "UPCOMING" | "NO DATE";

export function Today() {
  const navigate = useNavigate();
  const unit = useUnit();
  const [list, setList] = useState<WorkoutList | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rx, setRx] = useState<Record<string, ResolvedPrescriptionRow[]>>({});
  const [loadError, setLoadError] = useState(false);

  // most recent confirmed program drives the THIS WEEK section
  const program = list?.programs[0] ?? null;
  const workouts = useMemo(
    () =>
      program
        ? (list?.workouts ?? [])
            .filter((w) => w.program_id === program.id)
            .sort(weekOrder)
        : [],
    [list, program],
  );

  const reload = useCallback(() => {
    getPlannedWorkouts()
      .then((r) => {
        setList(r.data);
        setFromCache(r.fromCache);
        setLoadError(false);
      })
      .catch((e: unknown) => {
        setLoadError(true);
        reportError(e, "load workouts");
      });
  }, []);

  useEffect(() => {
    void cacheGet<ActiveSession>(cacheKeys.activeSession).then((a) =>
      setActive(a ?? null),
    );
    reload();
  }, [reload]);

  useEffect(() => {
    if (!program || workouts.length === 0) return;
    getDoneWorkoutIds(
      program.id,
      workouts.map((w) => w.id),
    )
      .then((r) => setDoneIds(new Set(r.data)))
      .catch((e: unknown) => reportError(e, "load week state"));
  }, [program, workouts]);

  const today = todayLocalIso();
  const anyDates = workouts.some((w) => w.scheduled_date !== null);

  const states = useMemo(() => {
    const map = new Map<string, WorkoutState>();
    let todayAssigned = false;
    for (const w of workouts) {
      if (doneIds.has(w.id)) {
        map.set(w.id, "DONE");
      } else if (w.skipped_at !== null) {
        map.set(w.id, "SKIPPED");
      } else if (anyDates) {
        if (w.scheduled_date === null) map.set(w.id, "NO DATE");
        else if (w.scheduled_date === today) map.set(w.id, "TODAY");
        else if (w.scheduled_date < today) map.set(w.id, "MISSED");
        else map.set(w.id, "UPCOMING");
      } else if (!todayAssigned) {
        map.set(w.id, "TODAY");
        todayAssigned = true;
      } else {
        map.set(w.id, "UPCOMING");
      }
    }
    return map;
  }, [workouts, doneIds, anyDates, today]);

  const doneCount = workouts.filter((w) => states.get(w.id) === "DONE").length;
  const skippedCount = workouts.filter(
    (w) => states.get(w.id) === "SKIPPED",
  ).length;

  const loadRx = useCallback(
    (workoutId: string) => {
      if (workoutId in rx) return;
      getResolvedPrescriptions(workoutId)
        .then((r) => setRx((prev) => ({ ...prev, [workoutId]: r.data })))
        .catch((e: unknown) => reportError(e, "load prescriptions"));
    },
    [rx],
  );

  const expand = (w: PlannedWorkoutRow) => {
    setExpanded(expanded === w.id ? null : w.id);
    loadRx(w.id);
  };

  // Today's workout opens itself once, so the right Start button is the one
  // in view (not the empty-session fallback at the bottom).
  const autoExpanded = useRef(false);
  useEffect(() => {
    if (autoExpanded.current || expanded !== null) return;
    const todayId = workouts.find((w) => states.get(w.id) === "TODAY")?.id;
    if (!todayId) return;
    autoExpanded.current = true;
    setExpanded(todayId);
    loadRx(todayId);
  }, [states, workouts, expanded, loadRx]);

  const setSkipped = async (w: PlannedWorkoutRow, skipped: boolean) => {
    try {
      await updatePlannedWorkout(w.id, {
        skipped_at: skipped ? new Date().toISOString() : null,
      });
      toast(skipped ? "Workout skipped" : "Workout back on the plan");
      reload();
    } catch (e) {
      reportError(e, skipped ? "skip workout" : "unskip workout");
    }
  };

  const start = async (workout: PlannedWorkoutRow | null) => {
    try {
      const sessionId = uuid();
      const startedAt = new Date().toISOString();
      let prescriptions: ResolvedPrescriptionRow[] = [];
      if (workout) {
        try {
          prescriptions =
            rx[workout.id] ?? (await getResolvedPrescriptions(workout.id)).data;
        } catch {
          prescriptions = []; // offline with no cache: start empty-ish
        }
      }
      await cacheSet(cacheKeys.sessionRx(sessionId), prescriptions);
      const activeSession: ActiveSession = {
        id: sessionId,
        planned_workout_id: workout?.id ?? null,
        started_at: startedAt,
        workout_label: workout?.label ?? null,
      };
      await cacheSet(cacheKeys.activeSession, activeSession);
      await outbox.enqueue({
        kind: "insert",
        table: "sessions",
        payload: {
          id: sessionId,
          planned_workout_id: workout?.id ?? null,
          started_at: startedAt,
        },
      });
      // Best-effort prefetch so the session screen works fully offline.
      // getLastActuals is keyed by excludeSessionId — warm the exact key the
      // session screen will read.
      void getExercises().catch(() => undefined);
      void getLastActuals(sessionId).catch(() => undefined);
      navigate("/session");
    } catch (e) {
      reportError(e, "start session");
    }
  };

  const dayLabel = (w: PlannedWorkoutRow): string =>
    w.scheduled_date
      ? formatPlannedDate(w.scheduled_date)
      : `DAY ${w.day_index + 1}`;

  const stateLabel = (state: WorkoutState): string =>
    state === "UPCOMING" ? "TO COME" : state;

  const moveToToday = (w: PlannedWorkoutRow) =>
    void (async () => {
      try {
        await updatePlannedWorkout(w.id, { scheduled_date: todayLocalIso() });
        toast("Moved to today");
        reload();
      } catch (e) {
        reportError(e, "move workout to today");
      }
    })();

  return (
    <div className="screen">
      {active && (
        <button
          type="button"
          className="resume-banner"
          onClick={() => navigate("/session")}
        >
          RESUME
          {active.workout_label
            ? ` · ${active.workout_label.toUpperCase()}`
            : " SESSION"}
        </button>
      )}

      <div className="today-heading">{formatTodayHeading()}</div>
      {program && (
        <div className="today-context">
          {program.name}
          {program.source_note ? ` — ${program.source_note}` : ""}
        </div>
      )}

      {fromCache && (
        <div className="cache-note">offline — showing cached plan</div>
      )}
      {loadError && !list && (
        <div className="warn-badge">
          Couldn’t load workouts (offline, no cache)
        </div>
      )}

      {program && (
        <section className="rule-section">
          <div className="section-head">
            <span className="field-label">THIS WEEK</span>
            <span className="section-meta">
              {doneCount} DONE · {workouts.length - doneCount - skippedCount} TO
              GO
              {skippedCount > 0 ? ` · ${skippedCount} SKIPPED` : ""}
            </span>
          </div>
          {anyDates &&
            !workouts.some((w) => states.get(w.id) === "TODAY") &&
            doneCount + skippedCount < workouts.length && (
              <div className="microcopy">
                Nothing scheduled today — rest day. Move a workout here to train
                anyway.
              </div>
            )}
          {workouts.map((w) => {
            const state = states.get(w.id) ?? "UPCOMING";
            const open = expanded === w.id;
            const muted = state === "DONE" || state === "SKIPPED";
            return (
              <div key={w.id} className="week-item">
                <button
                  type="button"
                  className="week-row"
                  onClick={() => expand(w)}
                >
                  <span
                    className={`week-day ${state === "TODAY" ? "week-day-today" : ""}`}
                  >
                    {dayLabel(w)}
                  </span>
                  <span
                    className={`week-label ${state === "TODAY" ? "week-label-today" : ""} ${muted ? "week-label-done" : ""}`}
                  >
                    {w.label ?? `Workout ${w.day_index + 1}`}
                    {w.plan_note ? <span className="note-dot"> ·</span> : ""}
                  </span>
                  <span
                    className={`week-state ${state === "TODAY" ? "week-state-today" : ""} ${state === "MISSED" ? "week-state-missed" : ""} ${state === "NO DATE" ? "week-state-nodate" : ""}`}
                  >
                    {stateLabel(state)}
                  </span>
                  <span className="chev">{open ? "▾" : "▸"}</span>
                </button>
                {open && (
                  <div className="week-detail">
                    {w.plan_note && (
                      <div className="detail-note">
                        <span className="detail-note-label">PLAN NOTE</span>
                        {w.plan_note}
                      </div>
                    )}
                    {w.notes && (
                      <div className="detail-note">
                        <span className="detail-note-label">COACH</span>
                        {w.notes}
                      </div>
                    )}
                    {(rx[w.id] ?? []).map((r) => (
                      <div key={r.id} className="rx-row">
                        <span className="rx-name">{r.exercise_name}</span>
                        <span className="rx-spec">
                          {formatRxTarget(r, unit)}
                        </span>
                        {rxHasNoTm(r) && (
                          <span className="warn-badge">no TM set</span>
                        )}
                      </div>
                    ))}
                    {!active && state === "TODAY" && (
                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        onClick={() => void start(w)}
                      >
                        Start session
                      </button>
                    )}
                    {!active && (state === "MISSED" || state === "NO DATE") && (
                      <button
                        type="button"
                        className="btn btn-outline-ink btn-block"
                        onClick={() => moveToToday(w)}
                      >
                        Move to today
                      </button>
                    )}
                    {state === "NO DATE" && (
                      <div className="microcopy">
                        No date set — move it to today, or pick a day in Edit.
                      </div>
                    )}
                    <div className="detail-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => navigate(`/plan/${w.id}`)}
                      >
                        Edit
                      </button>
                      {state !== "DONE" && state !== "SKIPPED" && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => void setSkipped(w, true)}
                        >
                          Skip
                        </button>
                      )}
                      {state === "SKIPPED" && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => void setSkipped(w, false)}
                        >
                          Unskip
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {list && !program && <p className="muted">No confirmed programs yet.</p>}

      {!active && (
        <button
          type="button"
          className="btn btn-secondary btn-block"
          onClick={() => void start(null)}
        >
          Start empty session
        </button>
      )}
    </div>
  );
}
