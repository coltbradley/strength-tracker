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
    loadPresentation: { perSide: false },
    unit: "kg",
    maxEntryKg: 999,
    loadSteps: [],
    logLabel: "LOG SET 1 OF 3",
    disabled: false,
    onDraftChange: () => undefined,
    onLog: () => undefined,
    onOpenPad: () => undefined,
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
  it("uses a completion action without numeric inputs for tick-only work", () => {
    render(
      <SetEditor {...props({ tracking: "done", logLabel: "DONE 1 OF 3" })} />,
    );
    expect(screen.getByRole("button", { name: /done 1 of 3/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /load value/i })).toBeNull();
  });

  it("does not render a cable pin that the data model cannot support", () => {
    render(<SetEditor {...props()} />);
    expect(screen.queryByText(/pin/i)).toBeNull();
  });

  it("renders the parent-applied draft and sends logging to the parent", () => {
    render(<ControlledHarness />);
    fireEvent.click(screen.getByRole("button", { name: "increase reps by 1" }));
    expect(
      screen.getByRole("button", { name: "reps value — tap to type" }).textContent,
    ).toBe("9reps");
    fireEvent.click(screen.getByRole("button", { name: "LOG SET 1 OF 3" }));
    expect(screen.getByText("Parent logs: 1")).toBeTruthy();
  });

  it("shows Saving... and refuses a second press while the log is in flight", () => {
    const onLog = vi.fn();
    render(<SetEditor {...props({ saving: true, onLog })} />);
    const button = screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(button);
    expect(onLog).not.toHaveBeenCalled();
  });

  it("names whose number the load card is in a superset round", () => {
    render(<SetEditor {...props({ memberTag: "A1" })} />);
    expect(screen.getByRole("group", { name: /^Dumbbell Bench Press set$/ }).textContent).toContain("kg · A1");
  });

  it("M3: a timed set keeps its load control beside the duration", () => {
    const onDraftChange = vi.fn();
    const { container } = render(
      <SetEditor
        {...props({
          tracking: "time",
          draft: { entryKg: 30, reps: 0, setType: "working", rpe: null, durationSeconds: 45 },
          loadSteps: [
            { label: "− 2.5", delta: -2.5, announce: "2.5 kg" },
            { label: "+ 2.5", delta: 2.5, announce: "2.5 kg" },
          ],
          onDraftChange,
        })}
      />,
    );
    expect(container.querySelector(".dock-row-time")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "increase load by 2.5 kg" }));
    expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ entryKg: 32.5 }));
  });
});

describe("SetEditor focus variant", () => {
  const loadSteps = [
    { label: "− 2.5", delta: -2.5, announce: "2.5 kg" },
    { label: "− 0.5", delta: -0.5, fine: true, announce: "0.5 kg" },
    { label: "+ 0.5", delta: 0.5, fine: true, announce: "0.5 kg" },
    { label: "+ 2.5", delta: 2.5, announce: "2.5 kg" },
  ];
  const bodyweight = { perSide: false, noLoad: true };

  function focus(overrides: Partial<SetEditorProps> = {}) {
    return props({
      loadSteps,
      loadPresentation: { perSide: false },
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

    const value = screen.getByRole("button", { name: "duration value — tap to type" });
    expect(value.textContent).toContain("75");
    expect(value.textContent).toContain("sec");
    fireEvent.click(value);
    expect(onOpenPad).toHaveBeenCalledWith("duration");
    fireEvent.click(screen.getByRole("button", { name: "increase duration by 5 seconds" }));
    expect(onDraftChange).toHaveBeenCalledWith({ durationSeconds: 80 });
    expect(screen.queryByRole("button", { name: /^load /i })).toBeNull();
  });

  it("UI-06: the tap-to-type button keeps its name and describes the current value", () => {
    render(
      <SetEditor
        {...focus({
          tracking: "time" as unknown as SetEditorProps["tracking"],
          draft: { ...props().draft, durationSeconds: 75 },
          loadPresentation: bodyweight,
          onOpenPad: vi.fn() as SetEditorProps["onOpenPad"],
        })}
      />,
    );
    const value = screen.getByRole("button", { name: "duration value — tap to type" });
    expect(value.getAttribute("aria-describedby")).toBeTruthy();
    const described = value
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toContain("75");
    expect(described).toContain("sec");
  });

  it("SESS-3: the duration stepper bottoms out at 1 second, never 0", () => {
    const onDraftChange = vi.fn();
    render(
      <SetEditor
        {...focus({
          tracking: "time" as unknown as SetEditorProps["tracking"],
          draft: { ...props().draft, durationSeconds: 3 },
          loadPresentation: bodyweight,
          onDraftChange,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "decrease duration by 5 seconds" }));
    expect(onDraftChange).toHaveBeenCalledWith({ durationSeconds: 1 });
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

    fireEvent.click(screen.getByRole("button", { name: "load value — tap to type" }));
    fireEvent.click(screen.getByRole("button", { name: "reps value — tap to type" }));
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

    expect(
      screen.getByRole("button", { name: "load value — tap to type" }).textContent,
    ).toContain("225.25");
  });

  it("marks per-side loads as 'each' in the load card", () => {
    render(
      <SetEditor
        {...focus({
          loadPresentation: { perSide: true },
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "load value — tap to type" }).textContent,
    ).toContain("kg each");
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
});
