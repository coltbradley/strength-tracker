// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  SupersetRoundEditor,
  type SupersetRoundEditorProps,
} from "./SupersetRoundEditor";
import type { SetDraft, SetEditorProps } from "./SetEditor";
import type { ExerciseEntry } from "../../lib/entries";

afterEach(cleanup);

const a1Entry: ExerciseEntry = {
  key: "bench",
  exercise_id: "bench-press",
  name: "Bench Press",
  brackets: [],
};

const a2Entry: ExerciseEntry = {
  key: "row",
  exercise_id: "barbell-row",
  name: "Barbell Row",
  brackets: [],
};

function editorProps(entry: ExerciseEntry, draft: SetDraft): SetEditorProps {
  return {
    entry,
    draft,
    tracking: "reps",
    loadPresentation: {
      perSide: false,
      totalKg: draft.entryKg,
      plateSplit: null,
      barKg: 0,
      hint: null,
      canToggleEntry: false,
    },
    unit: "kg",
    maxEntryKg: 999,
    loadSteps: [],
    rpeShown: false,
    logLabel: "unused",
    disabled: false,
    onDraftChange: () => undefined,
    onLog: () => undefined,
    onOpenPlates: () => undefined,
    onOpenPad: () => undefined,
    onToggleLoadEntry: () => undefined,
    onRevealRpe: () => undefined,
  };
}

function Harness({
  onLogRound,
  onLogA1Only,
}: Pick<SupersetRoundEditorProps, "onLogRound" | "onLogA1Only">) {
  const [a1, setA1] = useState<SetDraft>({
    entryKg: 40,
    reps: 8,
    setType: "working",
    rpe: null,
  });
  const [a2, setA2] = useState<SetDraft>({
    entryKg: 50,
    reps: 10,
    setType: "working",
    rpe: null,
  });

  return (
    <SupersetRoundEditor
      label="SUPERSET A · ROUND 1 OF 3"
      a1={{
        tag: "A1",
        editor: {
          ...editorProps(a1Entry, a1),
          onDraftChange: (next) => setA1((prior) => ({ ...prior, ...next })),
        },
      }}
      a2={{
        tag: "A2",
        editor: {
          ...editorProps(a2Entry, a2),
          onDraftChange: (next) => setA2((prior) => ({ ...prior, ...next })),
        },
      }}
      onLogRound={onLogRound}
      onLogA1Only={onLogA1Only}
    />
  );
}

describe("SupersetRoundEditor", () => {
  it("edits A1 and A2 independently and logs both with one action", () => {
    const onLogRound = vi.fn();
    render(<Harness onLogRound={onLogRound} onLogA1Only={vi.fn()} />);

    fireEvent.click(screen.getAllByRole("button", { name: "increase reps by 1" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "increase reps by 1" })[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "increase reps by 1" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));

    expect(onLogRound).toHaveBeenCalledWith({
      a1: expect.objectContaining({ reps: 9 }),
      a2: expect.objectContaining({ reps: 12 }),
    });
  });

  it("offers Log A1 only and never claims A2 is complete", () => {
    const onLogA1Only = vi.fn();
    render(<Harness onLogRound={vi.fn()} onLogA1Only={onLogA1Only} />);

    fireEvent.click(screen.getByRole("button", { name: "Log A1 only" }));

    expect(onLogA1Only).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/A2.*remaining/i)).toBeTruthy();
  });
});
