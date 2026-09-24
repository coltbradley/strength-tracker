// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { WorkoutOverview, type WorkoutOverviewProps } from "./WorkoutOverview";
import type { ExerciseEntry } from "../../lib/entries";
import { pinnedOverviewEntryKey } from "../../lib/sessionFocus";

afterEach(cleanup);

const entries: ExerciseEntry[] = [
  {
    key: "bench",
    exercise_id: "bench",
    name: "Bench Press",
    brackets: [],
  },
];

const correctionEntries: ExerciseEntry[] = [
  ...entries,
  {
    key: "squat",
    exercise_id: "squat",
    name: "Squat",
    brackets: [],
  },
];

function CorrectionHarness() {
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(null);
  const [expandedEntryKey, setExpandedEntryKey] = useState<string | null>("bench");
  const [correctedEntryKey, setCorrectedEntryKey] = useState<string | null>(null);
  const [saves, setSaves] = useState(0);
  const [logs, setLogs] = useState(0);
  const stagedDraft = "45 kg × 8";

  return (
    <>
      <button type="button" onClick={() => setCorrectedEntryKey("bench")}>
        Correct Bench Press
      </button>
      <WorkoutOverview
        {...props({
          entries: correctionEntries,
          selectedEntryKey,
          expandedEntryKey,
          onSelectEntry: setSelectedEntryKey,
          onToggleEntry: (key) =>
            setExpandedEntryKey((previous) =>
              pinnedOverviewEntryKey(
                previous === key ? null : key,
                correctedEntryKey,
              ),
            ),
          renderEditor: (entry) => (
            <section>
              <output>Editor: {entry.name}</output>
              <output>Draft: {stagedDraft}</output>
              {correctedEntryKey === entry.key ? (
                <button type="button" onClick={() => setSaves((count) => count + 1)}>
                  Save correction
                </button>
              ) : (
                <button type="button" onClick={() => setLogs((count) => count + 1)}>
                  Log set
                </button>
              )}
            </section>
          ),
        })}
      />
      <output>Saved: {saves}</output>
      <output>Logged: {logs}</output>
      <output>Selected: {selectedEntryKey ?? "none"}</output>
    </>
  );
}

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

  it("announces the selected exercise and exposes a return to current work", () => {
    render(<WorkoutOverview {...props({ selectedEntryKey: "bench" })} />);

    expect(screen.getByRole("button", { name: "Go to current exercise" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Bench Press, selected" }),
    ).toBeTruthy();
  });

  it("labels the return action for the current focused exercise", () => {
    render(<WorkoutOverview {...props({ selectedEntryKey: "bench" })} />);
    expect(
      screen.getByRole("button", { name: "Go to current exercise" }),
    ).toBeTruthy();
  });

  it("toggles expansion on the row name when focus mode is unavailable, like main", () => {
    const onToggleEntry = vi.fn();
    const onSelectEntry = vi.fn();
    render(
      <WorkoutOverview
        {...props({
          focusModeAvailable: false,
          onToggleEntry,
          onSelectEntry,
        })}
      />,
    );

    expect(screen.queryByRole("button", { name: "Focus mode" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /bench press/i }));

    expect(onToggleEntry).toHaveBeenCalledWith("bench");
    expect(onSelectEntry).not.toHaveBeenCalled();
  });

  it("collapses an open row by tapping its name again when focus mode is unavailable", () => {
    const onToggleEntry = vi.fn();
    render(
      <WorkoutOverview
        {...props({
          focusModeAvailable: false,
          expandedEntryKey: "bench",
          onToggleEntry,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /bench press/i }));

    expect(onToggleEntry).toHaveBeenCalledWith("bench");
  });

  it("pins Details to a correction while still allowing later focus selection", () => {
    render(<CorrectionHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Correct Bench Press" }));
    fireEvent.click(screen.getByRole("button", { name: "expand details" }));
    fireEvent.click(screen.getByRole("button", { name: "Squat" }));

    expect(screen.getByText("Editor: Bench Press")).toBeTruthy();
    expect(screen.getByText("Draft: 45 kg × 8")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save correction" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log set" })).toBeNull();
    expect(screen.getByText("Saved: 0")).toBeTruthy();
    expect(screen.getByText("Logged: 0")).toBeTruthy();
    expect(screen.getByText("Selected: squat")).toBeTruthy();
  });

  it("shows a state glyph and folds the state into the row's own accessible name, when given one", () => {
    render(
      <WorkoutOverview
        {...props({
          entries,
          selectedEntryKey: null,
          expandedEntryKey: null,
          entryState: () => "done",
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Bench Press — done/ }),
    ).toBeTruthy();
  });

  it("omits the glyph and leaves the row's name unchanged when no entryState is given", () => {
    render(
      <WorkoutOverview
        {...props({ entries, selectedEntryKey: null, expandedEntryKey: null })}
      />,
    );

    expect(screen.getByRole("button", { name: "Bench Press" })).toBeTruthy();
  });
});
