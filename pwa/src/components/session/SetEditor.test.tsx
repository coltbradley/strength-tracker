// @vitest-environment jsdom
// The set editor is controlled by Session. These tests protect the two
// distinct logging surfaces: numeric sets and tick-only work.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { SetEditor, type SetDraft, type SetEditorProps } from "./SetEditor";
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
    ...overrides,
  };
}

function ControlledHarness() {
  const [draft, setDraft] = useState<SetDraft>({
    entryKg: 30,
    reps: 8,
    setType: "working",
    rpe: null,
  });
  const [logs, setLogs] = useState(0);

  return (
    <>
      <SetEditor
        {...props({
          draft,
          onDraftChange: (next) =>
            setDraft((previous) => ({ ...previous, ...next })),
          onLog: () => setLogs((count) => count + 1),
        })}
      />
      <output>Parent logs: {logs}</output>
    </>
  );
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

  it("renders the parent-applied draft and sends logging to the parent", () => {
    render(<ControlledHarness />);

    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" })
        .textContent,
    ).toBe("9");

    fireEvent.click(screen.getByRole("button", { name: "LOG SET 1 OF 3" }));
    expect(screen.getByText("Parent logs: 1")).toBeTruthy();
  });

  it("emits the surrounding control intents without owning their state", () => {
    const onOpenPlates = vi.fn();
    const onOpenPad = vi.fn();
    const onToggleLoadEntry = vi.fn();
    const onRevealRpe = vi.fn();
    const base = props();
    render(
      <SetEditor
        {...props({
          loadPresentation: { ...base.loadPresentation, hint: "20 kg" },
          onOpenPlates,
          onOpenPad,
          onToggleLoadEntry,
          onRevealRpe,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "reps value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "one dumbbell in each hand; switch to one total weight",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "20 kg ›" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "add an RPE rating to Dumbbell Bench Press",
      }),
    );

    expect(onOpenPad).toHaveBeenNthCalledWith(1, "reps");
    expect(onOpenPad).toHaveBeenNthCalledWith(2, "load");
    expect(onToggleLoadEntry).toHaveBeenCalledTimes(1);
    expect(onOpenPlates).toHaveBeenCalledTimes(1);
    expect(onRevealRpe).toHaveBeenCalledTimes(1);
  });
});
