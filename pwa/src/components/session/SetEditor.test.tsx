// @vitest-environment jsdom
// The set editor is controlled by Session. These tests protect the two
// distinct logging surfaces: numeric sets and tick-only work.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SetEditor, type SetEditorProps } from "./SetEditor";
import type { ExerciseEntry } from "../../lib/entries";

afterEach(cleanup);

const entry: ExerciseEntry = {
  key: "rx-1",
  exercise_id: "Dumbbell_Bench_Press",
  name: "Dumbbell Bench Press",
  brackets: [],
};

function props(overrides: Partial<SetEditorProps> = {}): SetEditorProps {
  return {
    entry,
    draft: { entryKg: 30, reps: 8, setType: "working", rpe: null },
    tracking: "reps",
    loadPresentation: {
      perSide: true,
      totalKg: 60,
      plateSplit: null,
      barKg: 0,
      hint: null,
      canToggleEntry: true,
    },
    unit: "kg",
    maxEntryKg: 999,
    loadSteps: [],
    rpeShown: false,
    logLabel: "LOG SET 1 OF 3",
    disabled: false,
    onDraftChange: () => undefined,
    onLog: () => undefined,
    onOpenPlates: () => undefined,
    onOpenPad: () => undefined,
    onToggleLoadEntry: () => undefined,
    onRevealRpe: () => undefined,
    onSkip: () => undefined,
    onAddSet: () => undefined,
    onStartCorrection: () => undefined,
    ...overrides,
  };
}

describe("SetEditor", () => {
  it("shows per-hand input and a separate stored total", () => {
    render(<SetEditor {...props()} />);

    expect(screen.getByText("30 kg per hand")).toBeTruthy();
    expect(screen.getByText("60 kg total")).toBeTruthy();
  });

  it("uses a completion action without numeric inputs for tick-only work", () => {
    render(
      <SetEditor
        {...props({ tracking: "done", logLabel: "DONE 1 OF 3" })}
      />,
    );

    expect(screen.getByRole("button", { name: /done 1 of 3/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /load value/i })).toBeNull();
  });

  it("does not render a cable pin that the data model cannot support", () => {
    const base = props();
    render(
      <SetEditor
        {...props({
          loadPresentation: {
            ...base.loadPresentation,
            perSide: false,
            totalKg: 45,
          },
        })}
      />,
    );

    expect(screen.queryByText(/pin/i)).toBeNull();
  });
});
