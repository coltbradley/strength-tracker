// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkoutOverview, type WorkoutOverviewProps } from "./WorkoutOverview";
import type { ExerciseEntry } from "../../lib/entries";

afterEach(cleanup);

const entries: ExerciseEntry[] = [
  {
    key: "bench",
    exercise_id: "bench",
    name: "Bench Press",
    brackets: [],
  },
];

function props(
  overrides: Partial<WorkoutOverviewProps> = {},
): WorkoutOverviewProps {
  return {
    entries,
    selectedEntryKey: null,
    expandedEntryKey: null,
    onSelectEntry: () => undefined,
    onToggleEntry: () => undefined,
    onEnterFocus: () => undefined,
    renderEditor: () => <button type="button">Log set</button>,
    ...overrides,
  };
}

describe("WorkoutOverview", () => {
  it("marks an overview entry selected without writing a set", () => {
    const onSelectEntry = vi.fn();
    const onLog = vi.fn();

    render(
      <WorkoutOverview
        {...props({
          onSelectEntry,
          renderEditor: () => <button type="button" onClick={onLog}>Log set</button>,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /bench press/i }));

    expect(onSelectEntry).toHaveBeenCalledWith("bench");
    expect(onLog).not.toHaveBeenCalled();
  });

  it("announces the selected exercise and exposes Focus mode", () => {
    render(<WorkoutOverview {...props({ selectedEntryKey: "bench" })} />);

    expect(screen.getByRole("button", { name: "Focus mode" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Bench Press, selected" }),
    ).toBeTruthy();
  });
});
