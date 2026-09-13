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

  it("marks completed, current, and future sets in order without another spoken status", () => {
    const { container } = render(
      <FocusDeck
        {...props({ entryProgress: () => 1 })}
      />,
    );

    const progress = container.querySelector(".focus-set-progress");
    expect(progress?.getAttribute("aria-hidden")).toBe("true");
    expect(
      [...(progress?.querySelectorAll("[data-state]") ?? [])].map(
        (segment) => [
          segment.getAttribute("data-state"),
          segment.textContent,
        ],
      ),
    ).toEqual([
      ["completed", "✓"],
      ["current", "●"],
      ["future", ""],
    ]);
    expect(screen.getByText("SET 2 OF 3")).toBeTruthy();
    expect(container.querySelectorAll(".focus-deck-position")).toHaveLength(1);
  });

  it("omits the segmented line for by-feel work", () => {
    const byFeel = entry("by-feel", "Carry", 0);
    byFeel.brackets = [];
    const { container } = render(
      <FocusDeck
        {...props({ entries: [byFeel], entry: byFeel })}
      />,
    );

    expect(screen.getByText("SET BY FEEL")).toBeTruthy();
    expect(container.querySelector(".focus-set-progress")).toBeNull();
  });

  it("shows one shared superset round line derived from both members", () => {
    const a1 = entry("a1", "Bench Press", 3);
    const a2 = entry("a2", "Barbell Row", 4);
    a1.brackets[0] = { ...a1.brackets[0]!, superset_group: 1 };
    a2.brackets[0] = { ...a2.brackets[0]!, superset_group: 1 };
    const progressByKey: Record<string, number> = { a1: 2, a2: 1 };
    const { container } = render(
      <FocusDeck
        {...props({
          entries: [a1, a2],
          entry: a1,
          entryProgress: (candidate) => progressByKey[candidate.key] ?? 0,
          supersetHeading: { title: "Superset A", subtitle: "round 2 of 3" },
          renderEditor: () => (
            <section className="superset-round-editor">
              <div className="superset-round-actions">
                <button type="button">Log round</button>
              </div>
            </section>
          ),
        })}
      />,
    );

    expect(screen.getByRole("heading", { name: "Superset A" })).toBeTruthy();
    expect(screen.getByText("round 2 of 3")).toBeTruthy();
    expect(container.querySelectorAll(".focus-set-progress")).toHaveLength(1);
    expect(
      [...container.querySelectorAll(".focus-set-progress [data-state]")].map(
        (segment) => segment.getAttribute("data-state"),
      ),
    ).toEqual(["completed", "current", "future"]);
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
