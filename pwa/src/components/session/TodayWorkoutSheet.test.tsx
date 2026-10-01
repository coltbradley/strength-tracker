// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TodayWorkoutSheet } from "./TodayWorkoutSheet";
import {
  SessionHeaderControls,
  SessionHeaderPortal,
  SessionHeaderSlotContext,
} from "./SessionHeader";
import type { ExerciseEntry } from "../../lib/entries";

afterEach(() => cleanup());

const bracket = { kind: "working", sets: 3 };
const entry = (key: string, name: string, planned = true): ExerciseEntry =>
  ({
    key,
    name,
    exercise_id: key,
    brackets: planned ? [bracket] : [],
  }) as unknown as ExerciseEntry;

describe("TodayWorkoutSheet", () => {
  const entries = [entry("a", "Bench Press"), entry("b", "Back Squat")];
  const setup = (over: Partial<Parameters<typeof TodayWorkoutSheet>[0]> = {}) => {
    const props = {
      blocks: entries.map((e) => [e]),
      unit: "lb" as const,
      deviceUnit: "lb" as const,
      onUnitChange: vi.fn(),
      entryProgress: (e: ExerciseEntry) => (e.key === "a" ? 3 : 1),
      entryState: (e: ExerciseEntry) =>
        e.key === "a" ? ("done" as const) : ("current" as const),
      formatScheme: () => "3 x 5",
      onSelect: vi.fn(),
      onMoveBlock: vi.fn(() => true),
      canMoveBlock: () => true,
      onFinish: vi.fn(),
      onClose: vi.fn(),
      ...over,
    };
    render(<TodayWorkoutSheet {...props} />);
    return props;
  };

  it("changes units, shows each entry's count, and jumps on tap", () => {
    const p = setup();
    expect(screen.getByRole("dialog", { name: "Today's workout" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show weights in kilograms" }));
    expect(p.onUnitChange).toHaveBeenCalledWith("kg");
    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back Squat — current" }));
    expect(p.onSelect).toHaveBeenCalledWith(entries[1]);
    expect(p.onClose).toHaveBeenCalled();
  });

  it("says which unit only this workout uses when it differs from Settings", () => {
    setup({ unit: "kg" });
    expect(screen.getByText(/Settings says lb\. Only this workout shows kg/)).toBeTruthy();
  });

  it("reorders by keyboard and by the visible Move buttons", () => {
    const p = setup();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Reorder Back Squat/ }), {
      key: "ArrowUp",
    });
    expect(p.onMoveBlock).toHaveBeenCalledWith(1, 0);
    fireEvent.click(screen.getByRole("button", { name: "Move Bench Press down" }));
    expect(p.onMoveBlock).toHaveBeenCalledWith(0, 1);
  });

  it("disables a move the order rules refuse", () => {
    setup({ canMoveBlock: (i, d) => !(i === 0 && d === "down") });
    expect(
      (screen.getByRole("button", { name: "Move Bench Press down" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("locks every control while a save or correction is in flight", () => {
    setup({ reorderLocked: true });
    expect(screen.getByText(/Order is locked/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Move Bench Press down" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows a unit with several members as one block with a line each", () => {
    setup({
      blocks: [[entry("a", "Curl"), entry("b", "Press")]],
      supersetInfo: new Map([
        ["a", { tag: "A1" }],
        ["b", { tag: "A2" }],
      ]) as never,
    });
    expect(screen.getByRole("button", { name: "A1 · Curl — done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "A2 · Press — current" })).toBeTruthy();
  });

  it("shows the per-set receipt roll-up for a row", () => {
    setup({ receiptMark: ([e]) => (e.key === "a" ? { glyph: "◐", label: "On this phone" } : null) });
    expect(screen.getByRole("img", { name: "On this phone" })).toBeTruthy();
  });

  it("offers Add exercise and Back to Train, and finishes the session", () => {
    const onAddExercise = vi.fn();
    const onHome = vi.fn();
    const p = setup({ onAddExercise, onHome });
    fireEvent.click(screen.getByRole("button", { name: "+ Add exercise" }));
    expect(onAddExercise).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Back to Train/ }));
    expect(onHome).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }));
    expect(p.onFinish).toHaveBeenCalled();
  });

  it("disables rows a correction has locked", () => {
    setup({ isLocked: (e) => e.key === "a" });
    expect(
      (screen.getByRole("button", { name: "Bench Press — done" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("SessionHeaderControls", () => {
  const controls = (over = {}) => (
    <SessionHeaderControls
      done={9}
      total={25}
      presentation="focus"
      focusEligible
      onOpenWorkout={vi.fn()}
      onFocus={vi.fn()}
      onList={vi.fn()}
      {...over}
    />
  );

  it("shows done/total, marks the active view, and disables Focus when ineligible", () => {
    const { rerender } = render(controls());
    expect(
      screen.getByRole("button", { name: /^Today's workout, 9 of 25/ }).textContent,
    ).toContain("9/25");
    expect(
      screen.getByRole("button", { name: "Focus" }).getAttribute("aria-pressed"),
    ).toBe("true");
    rerender(controls({ presentation: "overview", focusEligible: false }));
    expect(
      (screen.getByRole("button", { name: "Focus" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("portals into the topbar slot when the shell provides one", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    render(
      <SessionHeaderSlotContext.Provider value={slot}>
        <SessionHeaderPortal>{controls()}</SessionHeaderPortal>
      </SessionHeaderSlotContext.Provider>,
    );
    expect(slot.querySelector(".session-hd-count")).not.toBeNull();
    slot.remove();
  });
});
