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
    keys: { onRpe: vi.fn(), onNote: vi.fn(), fourth: { label: "Swap", onPress: vi.fn() } },
    onSkip: vi.fn(),
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
    expect(screen.queryByText(/EXERCISE .* OF/)).toBeNull();
    expect(screen.queryByText(/REMAINING/)).toBeNull();
    // Version D: no top row, progress rail, more button or unit switch.
    expect(screen.queryByRole("list", { name: "workout progress" })).toBeNull();
    expect(screen.queryByRole("button", { name: /more options/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open workout" })).toBeNull();
  });

  it("puts the picture, cue and last time in the middle band and the editor in the dock", () => {
    const { container } = render(
      <FocusDeck
        {...props({
          picture: <div data-testid="pic">PLATES</div>,
          cue: "Pause on the chest",
          lastTime: "Last time · 185 lb × 5",
          dockTag: <div data-testid="tag">NEXT SET</div>,
        })}
      />,
    );

    const middle = container.querySelector(".focus-middle")!;
    const dock = container.querySelector(".focus-dock")!;
    expect(middle.contains(screen.getByTestId("pic"))).toBe(true);
    expect(middle.textContent).toContain("Pause on the chest");
    expect(middle.textContent).toContain("Last time · 185 lb × 5");
    expect(dock.contains(screen.getByTestId("tag"))).toBe(true);
    expect(dock.contains(screen.getByRole("button", { name: "DONE 1 OF 3" }))).toBe(true);
  });

  it("swaps the middle band for the rest slot while resting and hides cue/last time", () => {
    const { container } = render(
      <FocusDeck
        {...props({
          picture: <div data-testid="pic">PLATES</div>,
          cue: "Pause on the chest",
          lastTime: "Last time · 185 lb × 5",
          restSlot: <div data-testid="rest">REST 1:20</div>,
        })}
      />,
    );

    const middle = container.querySelector(".focus-middle")!;
    expect(middle.contains(screen.getByTestId("rest"))).toBe(true);
    expect(screen.queryByTestId("pic")).toBeNull();
    expect(middle.textContent).not.toContain("Pause on the chest");
    expect(middle.textContent).not.toContain("Last time");
  });

  it("V3: the unit note is on its own line, not inside the position row", () => {
    const { container } = render(
      <FocusDeck {...props({ unitNote: "Session unit · Settings says lb" })} />,
    );
    const note = screen.getByText("Session unit · Settings says lb");
    expect(container.querySelector(".focus-deck-position-row")!.contains(note)).toBe(false);
    expect(container.querySelector(".focus-deck-status")!.contains(note)).toBe(true);
  });

  it("V1: the middle band fades and says MORE only while content is hidden below the dock", () => {
    const sizes = { scrollHeight: 400, clientHeight: 200 };
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(() => sizes.scrollHeight);
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockImplementation(() => sizes.clientHeight);
    try {
      const { container, rerender } = render(<FocusDeck {...props()} />);
      expect(container.querySelector(".focus-middle--more")).not.toBeNull();
      expect(screen.getByText(/MORE/)).toBeTruthy();
      sizes.scrollHeight = 200;
      rerender(<FocusDeck {...props()} />);
      expect(container.querySelector(".focus-middle--more")).toBeNull();
      expect(screen.queryByText(/MORE/)).toBeNull();
    } finally {
      scrollHeight.mockRestore();
      clientHeight.mockRestore();
    }
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
      ["done", "✓"],
      ["current", "●"],
      ["upcoming", "○"],
    ]);
    expect(screen.getByText("SET 2 OF 3")).toBeTruthy();
    expect(container.querySelectorAll(".focus-deck-position")).toHaveLength(1);
  });

  it("marks the just-completed segment leaving and the new current one entering", () => {
    const { container, rerender } = render(
      <FocusDeck {...props({ entryProgress: () => 0 })} />,
    );

    rerender(<FocusDeck {...props({ entryProgress: () => 1 })} />);

    const segments = [
      ...container.querySelectorAll(".focus-set-progress [data-state]"),
    ];
    // index 0 just went current -> done: it plays the leaving motion.
    expect(segments[0]!.className).toContain("motion-set-logged");
    // index 1 just went upcoming -> current: it plays the entering motion.
    expect(segments[1]!.className).toContain("motion-set-entering");
    // index 2 was untouched.
    expect(segments[2]!.className).not.toContain("motion-set-logged");
    expect(segments[2]!.className).not.toContain("motion-set-entering");
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
            <section className="set-editor-focus">
              <button type="button">Log A1</button>
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
    ).toEqual(["done", "current", "upcoming"]);
  });

  it("does not present a local pair when its group number is reused later", () => {
    const a1 = entry("a1", "Bench Press", 3);
    const a2 = entry("a2", "Barbell Row", 4);
    const gap = entry("gap", "Overhead Press", 1);
    const b1 = entry("b1", "Curl", 5);
    const b2 = entry("b2", "Pushdown", 6);
    for (const member of [a1, a2, b1, b2]) {
      member.brackets[0] = { ...member.brackets[0]!, superset_group: 1 };
    }
    const progressByKey: Record<string, number> = {
      a1: 1,
      a2: 0,
      b1: 3,
      b2: 3,
    };
    const { container } = render(
      <FocusDeck
        {...props({
          entries: [a1, a2, gap, b1, b2],
          entry: a1,
          entryProgress: (candidate) => progressByKey[candidate.key] ?? 0,
          supersetHeading: { title: "Superset A", subtitle: "round 1 of 3" },
          renderEditor: () => <section className="set-editor-focus" />,
        })}
      />,
    );

    expect(
      [...container.querySelectorAll(".focus-set-progress [data-state]")].map(
        (segment) => segment.getAttribute("data-state"),
      ),
    ).toEqual(["done", "current", "upcoming"]);
  });

  it("keeps the supplied editor and hands it the key row as its second argument", () => {
    render(
      <FocusDeck
        {...props({
          renderEditor: (_entry, keys) => (
            <div>
              {keys}
              <button type="button">LOG</button>
            </div>
          ),
        })}
      />,
    );

    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual(["RPE", "Note", "Skip", "Swap", "LOG"]);
    expect(screen.queryByRole("list", { name: "workout progress" })).toBeNull();
  });

  it("keeps the live region to changing focus status, not controls", () => {
    render(<FocusDeck {...props()} />);

    const live = screen.getByText("Deadlift").closest("[aria-live]");
    expect(live).not.toBeNull();
    expect(live!.querySelector("button")).toBeNull();
  });

  function withKeys(overrides: Partial<FocusDeckProps> = {}) {
    return props({
      renderEditor: (_entry, keys) => <div>{keys}</div>,
      ...overrides,
    });
  }

  it("wires RPE, Note and the fourth key to Session", () => {
    const onRpe = vi.fn();
    const onNote = vi.fn();
    const onPress = vi.fn();
    render(
      <FocusDeck
        {...withKeys({ keys: { onRpe, onNote, fourth: { label: "Fix last", onPress } } })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "RPE" }));
    fireEvent.click(screen.getByRole("button", { name: "Note" }));
    fireEvent.click(screen.getByRole("button", { name: "Fix last" }));
    expect(onRpe).toHaveBeenCalledTimes(1);
    expect(onNote).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Swap" })).toBeNull();
  });

  it("disables the fourth key when Session supplies none", () => {
    render(
      <FocusDeck
        {...withKeys({ keys: { onRpe: vi.fn(), onNote: vi.fn(), fourth: null } })}
      />,
    );
    expect((screen.getByRole("button", { name: "Fix last" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the skip reasons inline in the middle band and emits one skip", () => {
    const onSkip = vi.fn();
    const { container } = render(<FocusDeck {...withKeys({ onSkip })} />);

    expect(screen.queryByRole("group", { name: "Skip reason" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    const prompt = screen.getByRole("group", { name: "Skip reason" });
    expect(container.querySelector(".focus-middle")!.contains(prompt)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Equipment taken" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledWith("Equipment taken");
    expect(screen.queryByRole("group", { name: "Skip reason" })).toBeNull();
  });

  it("skips with no reason, and Cancel closes the prompt without skipping", () => {
    const onSkip = vi.fn();
    render(<FocusDeck {...withKeys({ onSkip })} />);

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSkip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(screen.getByRole("button", { name: "No reason" }));
    expect(onSkip).toHaveBeenCalledWith(null);
  });

  it("turns Skip into Unskip for a skipped entry", () => {
    const onUnskip = vi.fn();
    render(<FocusDeck {...withKeys({ skipped: true, onUnskip })} />);

    expect(screen.getByText("Skipped. Unskip to log it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unskip" }));
    expect(onUnskip).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });

  it("keeps Unskip reachable when a skipped entry is done and the editor is gone", () => {
    const onUnskip = vi.fn();
    render(
      <FocusDeck
        {...props({
          entry: entries[0]!,
          skipped: true,
          onUnskip,
          canAdvance: true,
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "DONE 1 OF 3" })).toBeNull();
    expect(screen.getByText("Skipped. Unskip to log it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unskip" }));
    expect(onUnskip).toHaveBeenCalledTimes(1);
  });

  it("keeps All planned sets logged and + Extra set beside a rest that runs after the last set", () => {
    const onAddExtraSet = vi.fn();
    render(
      <FocusDeck
        {...props({
          entryDone: () => true,
          workoutComplete: true,
          onAddExtraSet,
          onFinishWorkout: vi.fn(),
          restSlot: <div data-testid="rest">REST 1:20</div>,
        })}
      />,
    );

    expect(screen.getByTestId("rest")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Extra set" }));
    expect(onAddExtraSet).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Finish session" })).toBeTruthy();
  });

  it("shows the NEXT EXERCISE card instead of the editor when the entry is done", () => {
    const onChooseNext = vi.fn();
    render(
      <FocusDeck
        {...props({
          entryDone: (candidate) => candidate.key !== "press",
          onChooseNext,
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "DONE 1 OF 3" })).toBeNull();
    expect(screen.getByText("NEXT EXERCISE →")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next exercise: Press" }));
    expect(onChooseNext).toHaveBeenCalledWith(entries[2]);
  });

  it("offers the next card only when Session permits advancing", () => {
    render(
      <FocusDeck
        {...props({
          entryDone: (candidate) => candidate.key !== "press",
          canAdvance: false,
        })}
      />,
    );

    expect(screen.queryByText("NEXT EXERCISE →")).toBeNull();
  });

  it("names the next exercise's own scheme on the card, when given a formatter", () => {
    render(
      <FocusDeck
        {...props({
          entryDone: (candidate) => candidate.key !== "press",
          formatScheme: (candidate) =>
            `4×5 @ ${candidate.name === "Press" ? 85 : 0}`,
        })}
      />,
    );

    expect(screen.getByText("Press")).toBeTruthy();
    expect(screen.getByText("4×5 @ 85")).toBeTruthy();
  });

  it("offers Finish session once the workout is complete, and + Extra set arms the editor", () => {
    const onFinishWorkout = vi.fn();
    const onAddExtraSet = vi.fn();
    const { rerender } = render(
      <FocusDeck
        {...props({
          entryDone: () => true,
          workoutComplete: true,
          onFinishWorkout,
          onAddExtraSet,
        })}
      />,
    );

    expect(screen.getByText("All planned sets logged.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "DONE 1 OF 3" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }));
    expect(onFinishWorkout).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "+ Extra set" }));
    expect(onAddExtraSet).toHaveBeenCalledTimes(1);

    rerender(
      <FocusDeck
        {...props({
          entryDone: () => true,
          workoutComplete: true,
          extraSetArmed: true,
          onFinishWorkout,
          onAddExtraSet,
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "DONE 1 OF 3" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Extra set" })).toBeNull();
    // While an extra set is being staged the dock is the editor; Finish is
    // one tap away in the Today's workout sheet.
    expect(screen.queryByRole("button", { name: "Finish session" })).toBeNull();
  });
});
