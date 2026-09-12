// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FocusDeck, type FocusDeckProps } from "./FocusDeck";
import type { ExerciseEntry } from "../../lib/entries";
import type { ResolvedPrescriptionRow } from "../../lib/types";

afterEach(cleanup);

function entry(key: string, name: string, sets: number): ExerciseEntry {
  const bracket: ResolvedPrescriptionRow = {
    id: `rx-${key}`,
    planned_workout_id: "workout-1",
    exercise_id: key,
    exercise_name: name,
    position: 0,
    sets,
    reps_min: 5,
    reps_max: 5,
    rest_seconds: 60,
    notes: null,
    load_kg: 20,
    load_pct_tm: null,
    tm_kg: null,
    resolved_load_kg: 20,
    plate_load_kg: null,
    superset_group: null,
  };
  return { key, exercise_id: key, name, brackets: [bracket] };
}

const entries = [
  entry("squat", "Squat", 2),
  entry("deadlift", "Deadlift", 3),
  entry("press", "Press", 1),
];

function props(overrides: Partial<FocusDeckProps> = {}): FocusDeckProps {
  return {
    entries,
    entry: entries[1]!,
    entryProgress: () => 0,
    entryDone: (candidate) => candidate.key === "squat",
    onViewFullWorkout: vi.fn(),
    onChooseNext: vi.fn(),
    renderEditor: () => <button type="button">DONE 1 OF 3</button>,
    ...overrides,
  };
}

describe("FocusDeck", () => {
  it("shows the current set plus remaining set and exercise counts", () => {
    render(<FocusDeck {...props()} />);

    expect(screen.getByText("EXERCISE 2 OF 3")).toBeTruthy();
    expect(screen.getByText("SET 1 OF 3")).toBeTruthy();
    expect(screen.getByText("SETS REMAINING 4")).toBeTruthy();
    expect(screen.getByText("EXERCISES REMAINING 2")).toBeTruthy();
  });

  it("keeps the supplied tick-only editor and offers the quiet overview action", () => {
    render(<FocusDeck {...props()} />);

    expect(screen.getByRole("button", { name: "DONE 1 OF 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View full workout" })).toBeTruthy();
  });
});
