// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    canAdvance: true,
    renderEditor: () => <button type="button">DONE 1 OF 3</button>,
    ...overrides,
  };
}

describe("FocusDeck", () => {
  it("shows only the exercise name and its set position by default", () => {
    render(<FocusDeck {...props()} />);

    expect(screen.getByRole("heading", { name: "Deadlift" })).toBeTruthy();
    expect(screen.getByText("SET 1 OF 3")).toBeTruthy();
    // The exercise/set counts across the whole workout moved behind "more".
    expect(screen.queryByText(/EXERCISE .* OF/)).toBeNull();
    expect(screen.queryByText(/REMAINING/)).toBeNull();
  });

  it("keeps the supplied tick-only editor and offers the quiet overview action", () => {
    render(<FocusDeck {...props()} />);

    expect(screen.getByRole("button", { name: "DONE 1 OF 3" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "View full workout" }),
    ).toBeTruthy();
  });

  it("keeps the live region to changing focus status, not controls", () => {
    render(<FocusDeck {...props()} />);

    const live = screen.getByText("Deadlift").closest("[aria-live]");
    expect(live).not.toBeNull();
    expect(live!.querySelector("button")).toBeNull();
  });

  it("uses its normal-exercise next action only when Session permits it", () => {
    const onChooseNext = vi.fn();
    render(
      <FocusDeck
        {...props({
          entryDone: (candidate) => candidate.key !== "press",
          onChooseNext,
          canAdvance: false,
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Next exercise" })).toBeNull();
  });

  it("names the next normal exercise and emits it through one action", () => {
    const onChooseNext = vi.fn();
    render(
      <FocusDeck
        {...props({
          entryDone: (candidate) => candidate.key !== "press",
          onChooseNext,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next exercise" }));

    expect(onChooseNext).toHaveBeenCalledWith(entries[2]);
  });

  it("names the next exercise's own scheme in the quiet next line, when given a formatter", () => {
    render(
      <FocusDeck
        {...props({
          entryDone: (candidate) => candidate.key !== "press",
          formatScheme: (candidate) =>
            `4×5 @ ${candidate.name === "Press" ? 85 : 0}`,
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Next exercise" }).textContent,
    ).toBe("next · Press · 4×5 @ 85");
  });

  it("offers one quiet control for everything else, when Session supplies it", () => {
    const onOpenMore = vi.fn();
    render(<FocusDeck {...props({ onOpenMore })} />);

    fireEvent.click(
      screen.getByRole("button", { name: "more options for Deadlift" }),
    );

    expect(onOpenMore).toHaveBeenCalledTimes(1);
  });

  it("omits the more control when Session does not supply one", () => {
    render(<FocusDeck {...props({ onOpenMore: undefined })} />);

    expect(screen.queryByRole("button", { name: /more options/ })).toBeNull();
  });
});
