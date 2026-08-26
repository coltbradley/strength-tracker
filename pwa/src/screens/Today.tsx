// Today: the confirmed program's week as a ruled list — DAY n rows with
// DONE / TODAY / TO COME states, expandable to prescriptions + start button.
// The schema has no calendar dates for planned workouts, so days are labeled
// DAY 1…N from day_index; only the header shows the real current date.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getDoneWorkoutIds,
  getExercises,
  getLastActuals,
  getPlannedWorkouts,
  getResolvedPrescriptions,
  type WorkoutList,
} from "../lib/data";
import { cacheGet, cacheSet, cacheKeys } from "../lib/db";
import { outbox } from "../lib/sync";
import { uuid } from "../lib/uuid";
import { reportError } from "../lib/errors";
import { formatRxTarget, formatTodayHeading, rxHasNoTm } from "../lib/format";
import { useUnit } from "../hooks/useUnit";
import type {
  ActiveSession,
  PlannedWorkoutRow,
  ResolvedPrescriptionRow,
} from "../lib/types";

type WorkoutState = "DONE" | "TODAY" | "TO COME";

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
        ? (list?.workouts.filter((w) => w.program_id === program.id) ?? [])
        : [],
    [list, program],
  );

  useEffect(() => {
    void cacheGet<ActiveSession>(cacheKeys.activeSession).then((a) =>
      setActive(a ?? null),
    );
    getPlannedWorkouts()
      .then((r) => {
        setList(r.data);
        setFromCache(r.fromCache);
      })
      .catch((e: unknown) => {
        setLoadError(true);
        reportError(e, "load workouts");
      });
  }, []);

  useEffect(() => {
    if (!program || workouts.length === 0) return;
    getDoneWorkoutIds(
      program.id,
      workouts.map((w) => w.id),
    )
      .then((r) => setDoneIds(new Set(r.data)))
      .catch((e: unknown) => reportError(e, "load week state"));
  }, [program, workouts]);

  const states = useMemo(() => {
    const map = new Map<string, WorkoutState>();
    let todayAssigned = false;
    for (const w of workouts) {
      if (doneIds.has(w.id)) {
        map.set(w.id, "DONE");
      } else if (!todayAssigned) {
        map.set(w.id, "TODAY");
        todayAssigned = true;
      } else {
        map.set(w.id, "TO COME");
      }
    }
    return map;
  }, [workouts, doneIds]);

  const doneCount = workouts.filter((w) => states.get(w.id) === "DONE").length;

  const expand = (w: PlannedWorkoutRow) => {
    setExpanded(expanded === w.id ? null : w.id);
    if (!(w.id in rx)) {
      getResolvedPrescriptions(w.id)
        .then((r) => setRx((prev) => ({ ...prev, [w.id]: r.data })))
        .catch((e: unknown) => reportError(e, "load prescriptions"));
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
              {doneCount} DONE · {workouts.length - doneCount} TO GO
            </span>
          </div>
          {workouts.map((w) => {
            const state = states.get(w.id) ?? "TO COME";
            const open = expanded === w.id;
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
                    DAY {w.day_index + 1}
                  </span>
                  <span
                    className={`week-label ${state === "TODAY" ? "week-label-today" : ""} ${state === "DONE" ? "week-label-done" : ""}`}
                  >
                    {w.label ?? `Workout ${w.day_index + 1}`}
                  </span>
                  <span
                    className={`week-state ${state === "TODAY" ? "week-state-today" : ""}`}
                  >
                    {state}
                  </span>
                  <span className="chev">{open ? "▾" : "▸"}</span>
                </button>
                {open && (
                  <div className="week-detail">
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
                    {!active && state !== "DONE" && (
                      <button
                        type="button"
                        className="btn btn-primary btn-block"
                        onClick={() => void start(w)}
                      >
                        Start session
                      </button>
                    )}
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
