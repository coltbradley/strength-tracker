// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ExerciseEntry } from "../../lib/entries";
import { FocusLoadStage, type FocusLoadStageProps } from "./FocusLoadStage";
import { BarbellIcon } from "../icons/LoadIcons";

afterEach(cleanup);

const entry: ExerciseEntry = {
  key: "rx-stage",
  exercise_id: "Barbell_Squat",
  name: "Barbell Squat",
  brackets: [],
};

function props(overrides: Partial<FocusLoadStageProps> = {}): FocusLoadStageProps {
  return {
    entry,
    draft: { entryKg: 82.5, reps: 5, setType: "working", rpe: null },
    tracking: "reps",
    loadPresentation: {
      perSide: false,
      totalKg: 82.5,
      plateSplit: null,
      barKg: 20,
    },
    unit: "kg",
    equipment: "barbell",
    cue: "Brace before unracking.",
    ...overrides,
  };
}

describe("FocusLoadStage", () => {
  it("shows the controlled load, base, equipment, and authored cue", () => {
    render(<FocusLoadStage {...props()} />);

    expect(screen.getByText("82.5 kg total")).toBeTruthy();
    expect(screen.getByText("20 kg base")).toBeTruthy();
    expect(screen.getByText("barbell")).toBeTruthy();
    expect(screen.getByText("Brace before unracking.")).toBeTruthy();
  });

  it("labels a per-hand draft with its whole-system total", () => {
    render(<FocusLoadStage {...props({
      draft: { entryKg: 30, reps: 8, setType: "working", rpe: null },
      loadPresentation: { ...props().loadPresentation, perSide: true, totalKg: 60, barKg: 0 },
      equipment: "dumbbell",
    })} />);

    expect(screen.getByText("30 kg per hand · 60 kg total")).toBeTruthy();
    expect(screen.getByLabelText("Barbell Squat movement details").querySelector("svg")).toBeTruthy();
  });

  it("describes bodyweight, timed, and completion-only work without a fake load", () => {
    const { rerender } = render(<FocusLoadStage {...props({
      tracking: "reps",
      draft: { entryKg: 0, reps: 10, setType: "working", rpe: null },
      loadPresentation: { ...props().loadPresentation, totalKg: 0, barKg: 0, noLoad: true },
      equipment: "body only",
      cue: null,
    })} />);
    expect(screen.getByText("Bodyweight · 10 reps")).toBeTruthy();
    expect(screen.queryByText(/0 kg/)).toBeNull();

    rerender(<FocusLoadStage {...props({
      tracking: "time",
      draft: { entryKg: 0, reps: 0, durationSeconds: 75, setType: "working", rpe: null },
      loadPresentation: { ...props().loadPresentation, totalKg: 0, barKg: 0, noLoad: true },
      equipment: "body only",
      cue: null,
    })} />);
    expect(screen.getByText("75 seconds")).toBeTruthy();

    rerender(<FocusLoadStage {...props({
      tracking: "done",
      draft: { entryKg: 0, reps: 0, setType: "working", rpe: null },
      loadPresentation: { ...props().loadPresentation, totalKg: 0, barKg: 0, noLoad: true },
      equipment: "body only",
      cue: null,
    })} />);
    expect(screen.getByText("Ready to complete")).toBeTruthy();
    expect(screen.queryByText(/0 kg/)).toBeNull();
  });

  it("keeps display-unit drafts and authored pounds from being converted twice", () => {
    const { rerender } = render(<FocusLoadStage {...props({
      draft: { entryKg: 82.5, reps: 5, setType: "working", rpe: null },
      loadPresentation: { ...props().loadPresentation, totalKg: 82.5 },
      unit: "lb",
      cue: null,
    })} />);
    expect(screen.getByText("181.9 lb total")).toBeTruthy();

    rerender(<FocusLoadStage {...props({
      draft: { entryKg: 90.718, enteredLoad: 200, enteredUnit: "lb", reps: 5, setType: "working", rpe: null },
      loadPresentation: { ...props().loadPresentation, totalKg: 90.718 },
      unit: "lb",
      cue: null,
    })} />);
    expect(screen.getByText("200 lb total")).toBeTruthy();
  });

  it("shows a truthful stack load without a plate diagram", () => {
    render(<FocusLoadStage {...props({
      equipment: "cable",
      loadPresentation: { ...props().loadPresentation, totalKg: 45, barKg: 0, styleIcon: { Icon: () => null, label: "weight stack — switch to plate-loaded" } },
    })} />);

    expect(screen.getByText("45 kg total on weight stack")).toBeTruthy();
    expect(screen.queryByText(/base/)).toBeNull();
  });

  it("uses the plate drawing as the sole loaded-bar visual", () => {
    render(<FocusLoadStage {...props({
      loadPresentation: {
        ...props().loadPresentation,
        plateSplit: { plates: [{ plate: 20, count: 1 }], perSideKg: 20, exact: true, achievedKg: 60 },
        styleIcon: { Icon: BarbellIcon, label: "barbell — loaded with plates" },
      },
    })} />);

    expect(screen.getByText("82.5 kg total")).toBeTruthy();
    expect(document.querySelector(".plate-bar")).toBeTruthy();
    expect(screen.getByLabelText("Barbell Squat movement details").querySelector("svg")).toBeNull();
  });
});
