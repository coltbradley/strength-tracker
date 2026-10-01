import type { ExerciseEntry } from "../../lib/entries";
import type { PlateSplit } from "../../lib/plates";
import { stagedDisplayLoad, toDisplay, type Unit } from "../../lib/units";
import type { SetDraft } from "./SetEditor";
import type { ComponentType } from "react";
import { PlateBar } from "../PlateBar";
import { DumbbellIcon, KettlebellIcon, StackIcon } from "../icons/LoadIcons";

export interface FocusLoadStageProps {
  entry: ExerciseEntry;
  draft: SetDraft;
  tracking: "reps" | "done" | "time";
  loadPresentation: {
    perSide: boolean;
    totalKg: number;
    plateSplit: PlateSplit | null;
    barKg: number;
    noLoad?: boolean;
    styleIcon?: { Icon: ComponentType<{ size?: number }>; label: string } | null;
  };
  unit: Unit;
  equipment: string | null;
  cue: string | null;
}

/** A read-only projection of the controlled Session draft and its existing
 * load calculation. It contains no editor state and never logs or mutates. */
export function FocusLoadStage({
  entry,
  draft,
  tracking,
  loadPresentation,
  unit,
  equipment,
  cue,
}: FocusLoadStageProps) {
  const { perSide, totalKg, plateSplit, barKg, noLoad, styleIcon } = loadPresentation;
  const displayed = stagedDisplayLoad(
    draft.entryKg,
    draft.enteredLoad,
    draft.enteredUnit,
    unit,
  );
  const shown = (value: number) => `${Math.round(value * 10) / 10}`;
  const loadLabel = perSide
    ? `${shown(displayed)} ${unit} per hand · ${shown(toDisplay(totalKg, unit))} ${unit} total`
    : `${shown(displayed)} ${unit} total`;
  const onStack = styleIcon?.label.startsWith("weight stack") ?? false;
  const loadVisual = styleIcon?.Icon ?? (equipment?.toLowerCase() === "dumbbell"
    ? DumbbellIcon
    : equipment?.toLowerCase().startsWith("kettlebell")
      ? KettlebellIcon
      : onStack
        ? StackIcon
        : null);
  const LoadVisual = loadVisual;
  const hasPlateVisual =
    tracking === "reps" && !noLoad && !onStack && plateSplit !== null;

  return (
    <div className="focus-load-stage" aria-label={`${entry.name} movement details`}>
      {LoadVisual && tracking === "reps" && !noLoad && !hasPlateVisual && (
        <div className="focus-load-stage-visual" aria-hidden="true">
          <LoadVisual size={64} />
        </div>
      )}
      {tracking === "done" ? (
        <div className="focus-load-stage-value">Ready to complete</div>
      ) : tracking === "time" ? (
        <div className="focus-load-stage-value">
          {draft.durationSeconds ?? 60} seconds
        </div>
      ) : noLoad ? (
        <div className="focus-load-stage-value">
          Bodyweight · {draft.reps} reps
        </div>
      ) : (
        <>
          <div className="focus-load-stage-value">
            {onStack ? `${toDisplay(totalKg, unit)} ${unit} total on weight stack` : loadLabel}
          </div>
          {!onStack && plateSplit && (
            <PlateBar split={plateSplit} barKg={barKg} unit={unit} />
          )}
          {!onStack && barKg > 0 && (
            <div className="focus-load-stage-base">{toDisplay(barKg, unit)} {unit} base</div>
          )}
        </>
      )}
      {equipment && <div className="focus-load-stage-equipment">{equipment}</div>}
      {cue && <div className="focus-load-stage-cue">{cue}</div>}
    </div>
  );
}
