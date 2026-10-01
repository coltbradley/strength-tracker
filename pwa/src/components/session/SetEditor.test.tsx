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

describe("SetEditor load-style icon", () => {
  it("shows a fixed, unlabelled-as-button icon for a barbell (no toggle)", () => {
    const base = props();
    render(
      <SetEditor
        {...props({
          loadPresentation: {
            ...base.loadPresentation,
            styleIcon: {
              Icon: () => <svg data-testid="bar-icon" />,
              label: "barbell — loaded with plates",
            },
          },
        })}
      />,
    );
    expect(
      screen.getByLabelText("barbell — loaded with plates"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "barbell — loaded with plates",
      }),
    ).toBeNull();
  });

  it("toggles plates <-> stack through the machine/cable icon", () => {
    const onToggle = vi.fn();
    const base = props();
    render(
      <SetEditor
        {...props({
          loadPresentation: {
            ...base.loadPresentation,
            styleIcon: {
              Icon: () => <svg data-testid="stack-icon" />,
              label: "weight stack — switch to plate-loaded",
              onToggle,
            },
          },
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "weight stack — switch to plate-loaded",
      }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("SetEditor focus variant", () => {
  const loadSteps = [
    { label: "− 2.5", delta: -2.5, announce: "2.5 kg" },
    { label: "− 0.5", delta: -0.5, fine: true, announce: "0.5 kg" },
    { label: "+ 0.5", delta: 0.5, fine: true, announce: "0.5 kg" },
    { label: "+ 2.5", delta: 2.5, announce: "2.5 kg" },
  ];
  const bodyweight = {
    perSide: false,
    totalKg: 0,
    plateSplit: null,
    barKg: 0,
    hint: null,
    canToggleEntry: false,
    noLoad: true,
  };

  function focus(overrides: Partial<SetEditorProps> = {}) {
    return props({
      variant: "focus",
      loadSteps,
      loadPresentation: {
        ...props().loadPresentation,
        perSide: false,
        totalKg: 30,
      },
      ...overrides,
    });
  }

  it("makes duration the large focus value and opens its numeric pad", () => {
    const onOpenPad = vi.fn();
    const onDraftChange = vi.fn();
    render(
      <SetEditor
        {...focus({
          tracking: "time" as unknown as SetEditorProps["tracking"],
          draft: { ...props().draft, durationSeconds: 75 },
          loadPresentation: bodyweight,
          onOpenPad: onOpenPad as SetEditorProps["onOpenPad"],
          onDraftChange,
        })}
      />,
    );

    const value = screen.getByRole("button", { name: "duration 75 sec, tap to type" });
    expect(value.textContent).toContain("75");
    expect(value.textContent).toContain("sec");
    fireEvent.click(value);
    expect(onOpenPad).toHaveBeenCalledWith("duration");
    fireEvent.click(screen.getByRole("button", { name: "increase duration by 5 seconds" }));
    expect(onDraftChange).toHaveBeenCalledWith({ durationSeconds: 80 });
    expect(screen.queryByRole("button", { name: /^load /i })).toBeNull();
  });

  it("puts load and reps side by side as cards, with the coarse load step on the load card", () => {
    const { container } = render(<SetEditor {...focus()} />);

    const row = container.querySelector(".dock-row")!;
    const cards = [...row.querySelectorAll(".dock-num")];
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("30");
    expect(cards[0]!.textContent).toContain("kg");
    expect(cards[1]!.textContent).toContain("8");
    expect(cards[1]!.textContent).toContain("reps");
    expect(cards[0]!.contains(screen.getByRole("button", { name: "decrease load by 2.5 kg" }))).toBe(true);
    expect(cards[0]!.contains(screen.getByRole("button", { name: "increase load by 2.5 kg" }))).toBe(true);
    expect(cards[1]!.contains(screen.getByRole("button", { name: "increase reps by 1" }))).toBe(true);
    expect(screen.getByRole("button", { name: "LOG SET 1 OF 3" })).toBeTruthy();
    // fine steps stay in the more sheet, and no inline set-type/RPE chrome
    expect(screen.queryByRole("button", { name: "increase load by 0.5 kg" })).toBeNull();
    expect(screen.queryByText("LOAD · KG")).toBeNull();
    expect(screen.queryByText("warmup")).toBeNull();
  });

  it("steps load and reps through the controlled draft, snapping load and clearing provenance", () => {
    const onDraftChange = vi.fn();
    render(
      <SetEditor
        {...focus({
          draft: {
            entryKg: 30,
            reps: 8,
            setType: "working",
            rpe: null,
            enteredLoad: 30,
            enteredUnit: "kg",
          },
          onDraftChange,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
    fireEvent.click(screen.getByRole("button", { name: "decrease load by 2.5 kg" }));
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    fireEvent.click(screen.getByRole("button", { name: "decrease reps by 1" }));

    expect(onDraftChange.mock.calls).toStrictEqual([
      [{ entryKg: 32.5, enteredLoad: undefined, enteredUnit: undefined }],
      [{ entryKg: 27.5, enteredLoad: undefined, enteredUnit: undefined }],
      [{ reps: 9 }],
      [{ reps: 7 }],
    ]);
  });

  it("opens the load and reps number pads from the cards", () => {
    const onOpenPad = vi.fn();
    render(<SetEditor {...focus({ onOpenPad })} />);

    fireEvent.click(screen.getByRole("button", { name: "load 30 kg, tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "reps 8 reps, tap to type" }));
    expect(onOpenPad.mock.calls).toEqual([["load"], ["reps"]]);
  });

  it("does not make the cards tappable when no pad is offered", () => {
    render(<SetEditor {...focus({ onOpenPad: undefined })} />);
    expect(screen.queryByRole("button", { name: /tap to type/ })).toBeNull();
  });

  it("clamps reps at zero", () => {
    const onDraftChange = vi.fn();
    render(
      <SetEditor
        {...focus({
          draft: { entryKg: 30, reps: 0, setType: "working", rpe: null },
          onDraftChange,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "decrease reps by 1" }));
    expect(onDraftChange).toHaveBeenCalledWith({ reps: 0 });
  });

  it("shows an authored lb value verbatim in the load card", () => {
    render(
      <SetEditor
        {...focus({
          unit: "lb",
          draft: {
            entryKg: 102.17,
            reps: 5,
            setType: "working",
            rpe: null,
            enteredLoad: 225.25,
            enteredUnit: "lb",
          },
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "load 225.25 lb, tap to type" })).toBeTruthy();
  });

  it("marks per-side loads as 'each' in the load card", () => {
    render(
      <SetEditor
        {...focus({
          loadPresentation: { ...props().loadPresentation, perSide: true, totalKg: 60 },
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "load 30 kg each, tap to type" })).toBeTruthy();
  });

  it("makes reps the only card for a bodyweight movement with no added load row", () => {
    render(<SetEditor {...focus({ loadPresentation: bodyweight })} />);

    expect(screen.queryByRole("button", { name: /^load /i })).toBeNull();
    expect(screen.queryByText(/added/)).toBeNull();
    expect(screen.getByRole("button", { name: "decrease reps by 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "increase reps by 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "LOG SET 1 OF 3" })).toBeTruthy();
  });

  describe("bodyweight added load", () => {
    const bw = (overrides: Partial<SetEditorProps> = {}) =>
      focus({
        loadPresentation: bodyweight,
        draft: { entryKg: 10, reps: 8, setType: "working", rpe: null },
        addedLoad: { on: true, onRemove: () => undefined },
        ...overrides,
      });

    it("shows a big reps card with a secondary added-load row that keeps the staged load visible", () => {
      const { container } = render(<SetEditor {...bw()} />);

      expect(container.querySelector(".dock-num-big")).not.toBeNull();
      expect(container.querySelector(".dock-row")).toBeNull();
      const row = container.querySelector(".dock-added-load")!;
      expect(row.textContent).toContain("+ 10 kg");
      expect(row.textContent).toContain("added");
    });

    it("steps the added load with −/+ using the coarse load steps", () => {
      const onDraftChange = vi.fn();
      render(<SetEditor {...bw({ onDraftChange })} />);

      fireEvent.click(screen.getByRole("button", { name: "increase added load by 2.5 kg" }));
      fireEvent.click(screen.getByRole("button", { name: "decrease added load by 2.5 kg" }));
      expect(onDraftChange.mock.calls).toStrictEqual([
        [{ entryKg: 12.5, enteredLoad: undefined, enteredUnit: undefined }],
        [{ entryKg: 7.5, enteredLoad: undefined, enteredUnit: undefined }],
      ]);
    });

    it("× calls onRemove and the row disappears when the caller turns it off", () => {
      const onRemove = vi.fn();
      const { container, rerender } = render(
        <SetEditor {...bw({ addedLoad: { on: true, onRemove } })} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "remove added load" }));
      expect(onRemove).toHaveBeenCalledTimes(1);

      rerender(<SetEditor {...bw({ addedLoad: { on: false, onRemove } })} />);
      expect(container.querySelector(".dock-added-load")).toBeNull();
      expect(screen.getByRole("button", { name: "increase reps by 1" })).toBeTruthy();
    });

    it("does not step the added load below zero", () => {
      const onDraftChange = vi.fn();
      render(
        <SetEditor
          {...bw({
            draft: { entryKg: 0, reps: 8, setType: "working", rpe: null },
            onDraftChange,
          })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "decrease added load by 2.5 kg" }));
      expect(onDraftChange).toHaveBeenCalledWith(
        expect.objectContaining({ entryKg: 0 }),
      );
    });
  });

  it("renders the keys slot after the numbers and before LOG", () => {
    render(
      <SetEditor
        {...focus({
          keysSlot: <div data-testid="keys"><button type="button">RPE</button></div>,
        })}
      />,
    );

    const order = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    const keysAt = order.indexOf("RPE");
    expect(keysAt).toBeGreaterThan(order.indexOf("increase reps by 1"));
    expect(order.indexOf("LOG SET 1 OF 3")).toBe(keysAt + 1);
  });

  it("keeps a single large tick action with no numbers for tracking = done", () => {
    render(
      <SetEditor
        {...focus({ tracking: "done", logLabel: "DONE 1 OF 3" })}
      />,
    );

    expect(screen.getByRole("button", { name: /done 1 of 3/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /increase|decrease/ })).toBeNull();
    expect(screen.queryByText(/no numbers for this one/i)).toBeNull();
  });

  it("fires onLog from the full-width Log button, honouring disabled", () => {
    const onLog = vi.fn();
    const { rerender } = render(<SetEditor {...focus({ onLog })} />);
    fireEvent.click(screen.getByRole("button", { name: "LOG SET 1 OF 3" }));
    expect(onLog).toHaveBeenCalledTimes(1);

    rerender(<SetEditor {...focus({ onLog, disabled: true })} />);
    expect((screen.getByRole("button", { name: "LOG SET 1 OF 3" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("gives a superset member (no log of its own) its number cards without a log button", () => {
    render(<SetEditor {...focus({ showLog: false })} />);

    expect(screen.getByRole("button", { name: "increase load by 2.5 kg" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /log set/i })).toBeNull();
  });
});
