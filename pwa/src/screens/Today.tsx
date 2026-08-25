// Today: pick a planned workout (confirmed programs, newest first), preview
// resolved prescriptions, start (or resume) a session.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
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
import { formatLoad } from "../lib/units";
import { useUnit } from "../hooks/useUnit";
import type {
  ActiveSession,
  PlannedWorkoutRow,
  ResolvedPrescriptionRow,
} from "../lib/types";

export function Today() {
  const navigate = useNavigate();
  const unit = useUnit();
  const [list, setList] = useState<WorkoutList | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rx, setRx] = useState<Record<string, ResolvedPrescriptionRow[]>>({});
  const [loadError, setLoadError] = useState(false);

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
      void getExercises().catch(() => undefined);
      void getLastActuals().catch(() => undefined);
      navigate("/session");
    } catch (e) {
      reportError(e, "start session");
    }
  };

  const programWorkouts = (programId: string) =>
    list?.workouts.filter((w) => w.program_id === programId) ?? [];

  return (
    <div className="screen">
      {active && (
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => navigate("/session")}
        >
          Resume session
          {active.workout_label ? ` · ${active.workout_label}` : ""}
        </button>
      )}

      {fromCache && (
        <div className="cache-note">offline — showing cached plan</div>
      )}
      {loadError && !list && (
        <div className="warn-badge">
          Couldn’t load workouts (offline, no cache)
        </div>
      )}

      {list?.programs.map((p) => (
        <section key={p.id} className="card">
          <div className="card-title">{p.name}</div>
          {programWorkouts(p.id).map((w) => (
            <div key={w.id} className="workout">
              <button
                type="button"
                className="workout-row"
                onClick={() => expand(w)}
              >
                <span>{w.label ?? `Day ${w.day_index + 1}`}</span>
                <span className="chev">{expanded === w.id ? "▾" : "▸"}</span>
              </button>
              {expanded === w.id && (
                <div className="workout-detail">
                  {(rx[w.id] ?? []).map((r) => (
                    <div key={r.id} className="rx-row">
                      <span className="rx-name">{r.exercise_name}</span>
                      <span className="rx-spec">
                        {r.sets}×
                        {r.reps_min === r.reps_max
                          ? r.reps_min
                          : `${r.reps_min}–${r.reps_max}`}
                        {r.plate_load_kg !== null || r.resolved_load_kg !== null
                          ? ` @ ${formatLoad(r.plate_load_kg ?? r.resolved_load_kg ?? 0, unit)}`
                          : ""}
                        {r.rest_seconds !== null
                          ? ` · ${r.rest_seconds}s rest`
                          : ""}
                      </span>
                      {r.load_pct_tm !== null &&
                        r.resolved_load_kg === null && (
                          <span className="warn-badge">no TM set</span>
                        )}
                    </div>
                  ))}
                  {!active && (
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
          ))}
        </section>
      ))}

      {list && list.programs.length === 0 && (
        <p className="muted">No confirmed programs yet.</p>
      )}

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
