import { useMemo } from "react";
import { groupRamps } from "../lib/entries";
import { formatPlannedDate, formatRxTarget, rxHasNoTm } from "../lib/format";
import type { Unit } from "../lib/units";
import type { PlannedWorkoutRow, ResolvedPrescriptionRow } from "../lib/types";
import { Note } from "./Note";
import { Sheet } from "./Sheet";

type Props = {
  workout: PlannedWorkoutRow;
  programName: string;
  prescriptions: ResolvedPrescriptionRow[] | null;
  loadState:
    | "loading"
    | "loaded"
    | "offline"
    | "error"
    | "cached-offline"
    | "cached-error";
  unit: Unit;
  startEnabled: boolean;
  onClose: () => void;
  onStart: (workout: PlannedWorkoutRow) => void;
};

function validSupersetLetters(
  groups: ResolvedPrescriptionRow[][],
): Map<number, string> {
  const members = new Map<number, number[]>();
  const compatible = (group: ResolvedPrescriptionRow[][][number]) =>
    group.every((row) => (row.tracking ?? "reps") === "reps");
  for (const [index, group] of groups.entries()) {
    const number = group[0]?.superset_group;
    if (
      number !== null &&
      number !== undefined &&
      Number.isInteger(number) &&
      number >= 1 &&
      number <= 4
    ) {
      members.set(number, [...(members.get(number) ?? []), index]);
    }
  }
  return new Map(
    [...members].flatMap(([number, indexes]) => {
      const [first, second] = indexes;
      if (
        indexes.length !== 2 ||
        second !== first + 1 ||
        !compatible(groups[first]) ||
        !compatible(groups[second])
      )
        return [];
      return [[number, String.fromCharCode(64 + number)] as const];
    }),
  );
}

export function WorkoutPreviewSheet({
  workout,
  programName,
  prescriptions,
  loadState,
  unit,
  startEnabled,
  onClose,
  onStart,
}: Props) {
  const groups = useMemo(
    () => (prescriptions === null ? [] : groupRamps(prescriptions)),
    [prescriptions],
  );
  const supersetLetters = validSupersetLetters(groups);
  const hasNamedSections = groups.some((group) =>
    Boolean(group[0]?.section?.trim()),
  );

  const detailsMessage =
    loadState === "offline"
      ? "Workout details are unavailable offline. Refresh your plan to retry."
      : loadState === "error"
        ? "Couldn’t load workout details. Refresh your plan to retry."
        : "Workout details are loading.";

  return (
    <Sheet
      title={`${workout.label ?? "Workout"} preview`}
      onClose={onClose}
      className="workout-preview"
      headRight={
        <button
          type="button"
          className="workout-preview-close"
          aria-label="Close preview"
          onClick={onClose}
        >
          ×
        </button>
      }
    >
      <div className="workout-preview-meta">
        <div className="train-kicker">{programName}</div>
        {workout.scheduled_date && (
          <p className="workout-preview-date">
            {formatPlannedDate(workout.scheduled_date)}
          </p>
        )}
      </div>

      {prescriptions === null ? (
        <p
          className="train-quiet"
          role={loadState === "error" || loadState === "offline" ? "alert" : "status"}
        >
          {detailsMessage}
        </p>
      ) : (
        <>
          {(loadState === "cached-offline" || loadState === "cached-error") && (
            <p className="train-cache-note" role="status">
              {loadState === "cached-offline"
                ? "Offline, showing saved workout details."
                : "Couldn’t refresh, showing saved workout details."}
            </p>
          )}
          {groups.length === 0 ? (
            <p className="train-quiet">No exercises are planned yet.</p>
          ) : (
            <>
              <div className="train-first-up workout-preview-first-up">
                <span>First up</span>
                <strong>{groups[0][0].exercise_name}</strong>
              </div>
              <div className="workout-preview-list">
                {groups.map((group, index) => {
                  const first = group[0];
                  const section = first.section?.trim() || null;
                  const priorSection =
                    index === 0
                      ? null
                      : groups[index - 1][0].section?.trim() || null;
                  const showSection = index === 0
                    ? hasNamedSections || section !== null
                    : section !== priorSection;
                  const sectionLabel =
                    section ?? (hasNamedSections ? "Main work" : null);
                  const notes = [
                    ...new Set(
                      group
                        .map((row) => row.notes?.trim())
                        .filter((note): note is string => Boolean(note)),
                    ),
                  ];
                  const rests = [
                    ...new Set(
                      group
                        .map((row) => row.rest_seconds)
                        .filter((seconds): seconds is number => seconds !== null),
                    ),
                  ];
                  const letter =
                    first.superset_group === null
                      ? null
                      : supersetLetters.get(first.superset_group) ?? null;

                  return (
                    <div className="workout-preview-entry" key={first.id}>
                      {showSection && sectionLabel && (
                        <h3 className="workout-preview-section">{sectionLabel}</h3>
                      )}
                      <div className="workout-preview-row">
                        <strong>
                          {letter && (
                            <span className="train-superset-tag">{letter} </span>
                          )}
                          {first.exercise_name}
                        </strong>
                        <span className="workout-preview-target">
                          {group.map((row) => formatRxTarget(row, unit)).join(" · ")}
                        </span>
                        {group.some(rxHasNoTm) && (
                          <span className="warn-badge">no TM set</span>
                        )}
                        {rests.map((seconds) => (
                          <span
                            className="workout-preview-rest"
                            key={`rest-${seconds}`}
                          >
                            Rest {seconds} sec
                          </span>
                        ))}
                        {notes.map((note) => (
                          <Note key={note} label="COACH CUE" text={note} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {workout.plan_note && <Note label="PLAN NOTE" text={workout.plan_note} />}
      {workout.notes && <Note label="COACH" text={workout.notes} />}

      <div className="workout-preview-actions">
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={
            !startEnabled ||
            prescriptions === null ||
            loadState === "loading"
          }
          onClick={() => onStart(workout)}
        >
          Start workout
        </button>
      </div>
    </Sheet>
  );
}
