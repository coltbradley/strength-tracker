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
      <SetEditor {...props({ tracking: "done", logLabel: "DONE 1 OF 3" })} />,
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

    fireEvent.click(
      screen.getByRole("button", { name: "reps value — tap to type" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "load value — tap to type" }),
    );
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

describe("SetEditor focus variant", () => {
  const loadSteps = [
    { label: "− 2.5", delta: -2.5, announce: "2.5 kg" },
    { label: "− 0.5", delta: -0.5, fine: true, announce: "0.5 kg" },
    { label: "+ 0.5", delta: 0.5, fine: true, announce: "0.5 kg" },
    { label: "+ 2.5", delta: 2.5, announce: "2.5 kg" },
  ];

  it("makes load the hero and moves its coarse step to the bottom bar beside LOG", () => {
    render(
      <SetEditor
        {...props({
          variant: "focus",
          loadSteps,
          loadPresentation: {
            ...props().loadPresentation,
            perSide: false,
            totalKg: 30,
          },
        })}
      />,
    );

    // the coarse pair flanks the log action — the only step control visible
    expect(
      screen.getByRole("button", { name: "decrease load by 2.5 kg" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "increase load by 2.5 kg" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "LOG SET 1 OF 3" })).toBeTruthy();
    // no other step buttons compete with it — fine adjustment and reps' own
    // nudge are gone from the default screen; tap-to-type still reaches both
    expect(
      screen.queryByRole("button", { name: "increase load by 0.5 kg" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "increase reps by 1" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" }),
    ).toBeTruthy();
    // target guidance remains in More, so neither value competes with the hero
    expect(screen.queryByText("target 8-15")).toBeNull();
    // no labels or secondary controls compete with the hero
    expect(screen.queryByText("LOAD · KG")).toBeNull();
    expect(screen.queryByText("REPS")).toBeNull();
  });

  it("makes the per-side convention explicit beside the loaded focus hero", () => {
    render(
      <SetEditor
        {...props({
          variant: "focus",
          loadSteps,
          loadPresentation: {
            ...props().loadPresentation,
            perSide: true,
            totalKg: 60,
          },
        })}
      />,
    );

    expect(screen.getByText("EACH HAND × 2 · 60 KG TOTAL")).toBeTruthy();
    expect(screen.getByText("30 kg per hand")).toBeTruthy();
  });

  it("makes reps the hero and omits the load field for a bodyweight movement", () => {
    render(
      <SetEditor
        {...props({
          variant: "focus",
          loadPresentation: {
            perSide: false,
            totalKg: 0,
            plateSplit: null,
            barKg: 0,
            hint: null,
            canToggleEntry: false,
            noLoad: true,
          },
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: /load value/i })).toBeNull();
    expect(screen.queryByText(/bodyweight|no load/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "decrease reps by 1" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "increase reps by 1" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "LOG SET 1 OF 3" })).toBeTruthy();
  });

  it("keeps a single large tick action with no step bar for tracking = done", () => {
    render(
      <SetEditor
        {...props({
          variant: "focus",
          tracking: "done",
          logLabel: "DONE 1 OF 3",
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /done 1 of 3/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /increase|decrease/ }),
    ).toBeNull();
    expect(
      screen.queryByText(/no numbers for this one/i),
    ).toBeNull();
  });

  it("gives a superset member (no log of its own) its hero step buttons without a log button", () => {
    render(
      <SetEditor
        {...props({
          variant: "focus",
          showLog: false,
          loadSteps,
          loadPresentation: {
            ...props().loadPresentation,
            perSide: false,
            totalKg: 30,
          },
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "increase load by 2.5 kg" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /log set/i })).toBeNull();
  });
});
