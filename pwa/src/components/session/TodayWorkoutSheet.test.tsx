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
      entries,
      unit: "lb" as const,
      onUnitChange: vi.fn(),
      entryProgress: (e: ExerciseEntry) => (e.key === "a" ? 3 : 1),
      entryState: (e: ExerciseEntry) =>
        e.key === "a" ? ("done" as const) : ("current" as const),
      isSkipped: () => false,
      formatScheme: () => "3 × 5",
      onSelect: vi.fn(),
      onFinish: vi.fn(),
      onClose: vi.fn(),
      ...over,
    };
    render(<TodayWorkoutSheet {...props} />);
    return props;
  };

  it("changes units, shows each entry's count, and jumps on tap", () => {
    const p = setup({ renderRowHandle: () => <span data-testid="handle" /> });
    expect(screen.getByRole("dialog", { name: "Today's workout" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show weights in kilograms" }));
    expect(p.onUnitChange).toHaveBeenCalledWith("kg");

    expect(screen.getByText("3/3")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getAllByTestId("handle")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Back Squat — current" }));
    expect(p.onSelect).toHaveBeenCalledWith(entries[1]);
    expect(p.onClose).toHaveBeenCalled();
  });

  it("finishes the session", () => {
    const p = setup();
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
