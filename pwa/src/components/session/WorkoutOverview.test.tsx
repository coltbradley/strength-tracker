// @vitest-environment jsdom
//
// List is the whole workout as a ledger: one open card (the exercise you are
// on), every other exercise one quiet row. It owns no draft and no write.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkoutOverview, type WorkoutOverviewProps } from "./WorkoutOverview";
import type { ExerciseEntry } from "../../lib/entries";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const entry = (key: string, name: string, extra: Partial<ExerciseEntry> = {}): ExerciseEntry =>
  ({
    key,
    name,
    exercise_id: key,
    brackets: [{ kind: "working", sets: 3 }],
    ...extra,
  }) as unknown as ExerciseEntry;

const entries = [entry("a", "Bench Press"), entry("b", "Back Squat"), entry("c", "Row")];

function setup(over: Partial<WorkoutOverviewProps> = {}) {
  const props: WorkoutOverviewProps = {
    entries,
    currentKey: "b",
    entryState: (e) => (e.key === "a" ? "done" : e.key === "b" ? "current" : "upcoming"),
    entryProgress: (e) => (e.key === "a" ? 3 : e.key === "b" ? 1 : 0),
    isSkipped: () => false,
    formatScheme: () => "3 x 5",
    onJump: vi.fn(),
    renderCurrent: (e) => <div data-testid="current-body">{e.name} editor</div>,
    ...over,
  };
  return { props, ...render(<WorkoutOverview {...props} />) };
}

describe("WorkoutOverview", () => {
  it("opens one card with its body and shows every other exercise as a row", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Back Squat" })).toBeTruthy();
    expect(screen.getByTestId("current-body").textContent).toBe("Back Squat editor");
    expect(screen.getByRole("button", { name: "Bench Press — done" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Row — upcoming" })).toBeTruthy();
    // only the open card has a body: no per-row accordion
    expect(screen.getAllByTestId("current-body")).toHaveLength(1);
  });

  it("jumps on a tap of any other row", () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Row — upcoming" }));
    expect(props.onJump).toHaveBeenCalledWith(entries[2]);
  });

  it("shows counts, a scheme for upcoming rows and a done count for finished ones", () => {
    setup();
    expect(screen.getByText("3 done")).toBeTruthy();
    expect(screen.getByText("3 X 5")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
    expect(screen.getByText("3/3")).toBeTruthy();
  });

  it("marks a skipped exercise as skipped, and a substituted one as INSTEAD OF", () => {
    setup({
      isSkipped: (e) => e.key === "c",
      entries: [
        entries[0]!,
        entry("b", "Goblet Squat", {
          substitutedFor: { name: "Back Squat", exercise_id: "x" },
        } as Partial<ExerciseEntry>),
        entries[2]!,
      ],
      entryState: (e) => (e.key === "c" ? "skipped" : e.key === "b" ? "current" : "done"),
    });
    expect(screen.getByText("SKIPPED")).toBeTruthy();
    expect(screen.getByText("INSTEAD OF BACK SQUAT")).toBeTruthy();
  });

  it("puts the rest strip above the rows", () => {
    const { container } = setup({ restSlot: <div data-testid="rest">REST</div> });
    expect(container.querySelector(".wk-overview")!.firstElementChild).toBe(
      screen.getByTestId("rest"),
    );
  });

  it("shows a superset tag on both the open card and a row", () => {
    setup({
      supersetInfo: new Map([
        ["b", { tag: "A1" }],
        ["c", { tag: "A2" }],
      ]) as never,
    });
    expect(screen.getByLabelText("Superset A1")).toBeTruthy();
    expect(screen.getByText("A2")).toBeTruthy();
  });

  it("heads each named section, and the unnamed run after one as MAIN WORK", () => {
    const sectioned = [
      entry("a", "Cat Cow", { brackets: [{ kind: "working", sets: 1, section: "Warm-up" }] } as never),
      entry("b", "Back Squat"),
    ];
    setup({ entries: sectioned, hasSections: true, currentKey: "b" });
    expect(screen.getByText("WARM-UP")).toBeTruthy();
    expect(screen.getByText("MAIN WORK")).toBeTruthy();
  });

  it("writes nothing by itself", () => {
    const { props } = setup();
    expect(props.onJump).not.toHaveBeenCalled();
  });
});
