import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { groupRamps } from "../lib/entries";
import type { Unit } from "../lib/units";
import type {
  ActiveSession,
  PlannedWorkoutRow,
  ResolvedPrescriptionRow,
} from "../lib/types";
import { formatPlannedDate } from "../lib/format";
import { WorkoutPreviewSheet } from "./WorkoutPreviewSheet";

export type TrainWorkoutState =
  "DONE" | "SKIPPED" | "TODAY" | "MISSED" | "UPCOMING" | "NO DATE" | "DRAFT";

export interface TrainWorkout {
  workout: PlannedWorkoutRow;
  state: TrainWorkoutState;
}

export interface TrainWorkoutSummary {
  movementCount: number;
  prescribedSetCount: number;
  firstUp: string | null;
}

/**
 * The train surface counts movements the same way the session does: adjacent
 * ramp brackets are one movement, while every prescribed set remains a set.
 */
export function summarizeTrainWorkout(
  prescriptions: ResolvedPrescriptionRow[],
): TrainWorkoutSummary {
  const groups = groupRamps(prescriptions);
  return {
    movementCount: groups.length,
    prescribedSetCount: prescriptions.reduce(
      (total, row) => total + row.sets,
      0,
    ),
    firstUp: groups[0]?.[0]?.exercise_name ?? null,
  };
}

export function TrainHome({
  dateContext,
  programName,
  loading,
  loadIssue,
  stale,
  workout,
  prescriptions,
  prescriptionLoadState,
  active,
  recovery,
  startEnabled,
  unit = "lb",
  onStart,
  onOpenCoach,
  onCheckIn,
}: {
  dateContext: string;
  programName: string | null;
  loading: boolean;
  loadIssue: "offline" | "error" | null;
  stale?: "offline" | "error" | null;
  workout: TrainWorkout | null;
  prescriptions: ResolvedPrescriptionRow[] | null;
  prescriptionLoadState:
    | "loading"
    | "loaded"
    | "offline"
    | "error"
    | "cached-offline"
    | "cached-error";
  active: ActiveSession | null;
  /** Recovery is owned by Today because it reconciles and repairs sessions. */
  recovery: ReactNode;
  startEnabled: boolean;
  unit?: Unit;
  onStart: (workout: PlannedWorkoutRow) => void;
  onOpenCoach: () => void;
  onCheckIn?: () => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const summary =
    prescriptions === null ? null : summarizeTrainWorkout(prescriptions);

  return (
    <section className="train-home" aria-label="Train">
      <div className="date-heading-row">
        <div className="train-date">{dateContext}</div>
        {onCheckIn && (
          <button type="button" className="checkin-link" onClick={onCheckIn}>
            Check in <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
      {stale && (
        <p className="train-cache-note">
          {stale === "offline"
            ? "Offline, showing your saved plan."
            : "Couldn’t refresh, showing your saved plan."}
        </p>
      )}

      {active ? (
        <div className="train-state">
          <div className="train-kicker">SESSION IN PROGRESS</div>
          <Link className="btn btn-primary btn-block" to="/session">
            Resume
          </Link>
        </div>
      ) : recovery ? (
        <div className="train-recovery">{recovery}</div>
      ) : loading ? (
        <p className="train-quiet">Loading your plan…</p>
      ) : loadIssue ? (
        <div className="train-state">
          <p className="train-quiet">
            {loadIssue === "offline"
              ? "Couldn’t load your plan while offline."
              : "Couldn’t load your plan. Try again when the connection is back."}
          </p>
          <Link className="train-link" to="/program">
            View program
          </Link>
        </div>
      ) : programName === null ? (
        <div className="train-state">
          <div className="train-kicker">START HERE</div>
          <h1 className="train-title">No program yet</h1>
          <p className="train-quiet">
            Build your plan in Program, or ask the coach to help write it.
          </p>
          <Link className="btn btn-primary btn-block" to="/program">
            View program
          </Link>
          <button type="button" className="train-link" onClick={onOpenCoach}>
            Ask the coach
          </button>
        </div>
      ) : workout === null ? (
        <div className="train-state">
          <div className="train-kicker">TODAY</div>
          <h1 className="train-title">Rest day</h1>
          <p className="train-quiet">Nothing is scheduled for today.</p>
          <Link className="train-link" to="/program">
            View program
          </Link>
        </div>
      ) : workout.state === "DONE" ? (
        <div className="train-state">
          <div className="train-kicker">COMPLETE</div>
          <h1 className="train-title">{workout.workout.label ?? "Workout"}</h1>
          <Link className="btn btn-primary btn-block" to="/history">
            View record
          </Link>
          <Link className="train-link" to="/program">
            View program
          </Link>
        </div>
      ) : workout.state === "DRAFT" ? (
        // A dated day nobody has filled in yet. It is not a rest day and
        // never a missed one: say what it is and send the way to fill it.
        <div className="train-state">
          <h1 className="train-title">{workout.workout.label ?? "Workout"}</h1>
          <p className="train-quiet">No exercises planned yet.</p>
          <Link className="train-link" to="/program">
            View program
          </Link>
        </div>
      ) : workout.state !== "TODAY" && workout.state !== "UPCOMING" ? (
        <div className="train-state">
          <h1 className="train-title">Rest day</h1>
          <p className="train-quiet">Nothing is ready to start today.</p>
          <Link className="train-link" to="/program">
            View program
          </Link>
        </div>
      ) : (
        <div className="train-state">
          <div className="train-kicker">
            {workout.state === "UPCOMING" ? "REST DAY · NEXT WORKOUT" : programName}
          </div>
          <h1 className="train-title">
            {workout.state === "UPCOMING" ? "Rest day" : workout.workout.label ?? "Workout"}
          </h1>
          {workout.state === "UPCOMING" && (
            <div className="train-next-workout">
              <span>{formatPlannedDate(workout.workout.scheduled_date!)}</span>
              <strong>{workout.workout.label ?? "Workout"}</strong>
            </div>
          )}
          {summary === null ? (
            <p className="train-quiet">
              {prescriptionLoadState === "offline"
                ? "Workout details are unavailable offline. Refresh your plan to retry."
                : prescriptionLoadState === "error"
                  ? "Couldn’t load workout details. Refresh your plan to retry."
                  : "Workout details are loading."}
            </p>
          ) : (
            <>
              <p className="train-shape">
                {summary.movementCount}{" "}
                {summary.movementCount === 1 ? "movement" : "movements"} ·{" "}
                {summary.prescribedSetCount}{" "}
                {summary.prescribedSetCount === 1 ? "set" : "sets"}
              </p>
              {(prescriptionLoadState === "cached-offline" ||
                prescriptionLoadState === "cached-error") && (
                <p className="train-cache-note" role="status">
                  {prescriptionLoadState === "cached-offline"
                    ? "Offline, showing saved workout details."
                    : "Couldn’t refresh, showing saved workout details."}
                </p>
              )}
              {summary.firstUp && (
                <div className="train-first-up">
                  <span>First up</span>
                  <strong>{summary.firstUp}</strong>
                </div>
              )}
            </>
          )}
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!startEnabled}
            onClick={() => setPreviewOpen(true)}
          >
            Go
          </button>
          <Link className="train-link" to="/program">
            View program
          </Link>
        </div>
      )}
      {previewOpen && workout && programName && (
        <WorkoutPreviewSheet
          workout={workout.workout}
          programName={programName}
          prescriptions={prescriptions}
          loadState={prescriptionLoadState}
          unit={unit}
          startEnabled={startEnabled}
          onClose={() => setPreviewOpen(false)}
          onStart={(selected) => {
            setPreviewOpen(false);
            onStart(selected);
          }}
        />
      )}
    </section>
  );
}
