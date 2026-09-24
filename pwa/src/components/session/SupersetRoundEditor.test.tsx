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

const loadSteps = [
  { label: "− 2.5", delta: -2.5, announce: "2.5 kg" },
  { label: "+ 2.5", delta: 2.5, announce: "2.5 kg" },
];

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
    loadSteps,
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
  onLogA2Only = () => undefined,
  pendingMember = null,
}: Pick<SupersetRoundEditorProps, "onLogRound" | "onLogA1Only"> &
  Partial<Pick<SupersetRoundEditorProps, "onLogA2Only" | "pendingMember">>) {
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
      onLogA2Only={onLogA2Only}
      pendingMember={pendingMember}
    />
  );
}

describe("SupersetRoundEditor", () => {
  it("leaves round status to the FocusDeck instead of repeating it as a region name", () => {
    const { container } = render(
      <Harness onLogRound={vi.fn()} onLogA1Only={vi.fn()} />,
    );

    expect(screen.getByRole("region", { name: "SUPERSET A" })).toBeTruthy();
    expect(
      screen.queryByRole("region", { name: "SUPERSET A · ROUND 1 OF 3" }),
    ).toBeNull();
    expect(container.querySelector(".focus-set-progress")).toBeNull();
  });

  it("edits A1 and A2 independently and logs both with one action", () => {
    const onLogRound = vi.fn();
    render(<Harness onLogRound={onLogRound} onLogA1Only={vi.fn()} />);

    fireEvent.click(
      screen.getAllByRole("button", { name: "increase load by 2.5 kg" })[0],
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "increase load by 2.5 kg" })[1],
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "increase load by 2.5 kg" })[1],
    );
    fireEvent.click(screen.getByRole("button", { name: "Log round" }));

    expect(onLogRound).toHaveBeenCalledWith({
      a1: expect.objectContaining({ entryKg: 42.5 }),
      a2: expect.objectContaining({ entryKg: 55 }),
    });
  });

  it("renders equal member cards with their own target, authored unit, and history", () => {
    const a1Draft: SetDraft = {
      entryKg: 102.17,
      enteredLoad: 225.25,
      enteredUnit: "lb",
      reps: 8,
      setType: "working",
      rpe: null,
    };
    const { container } = render(
      <SupersetRoundEditor
        label="SUPERSET A · ROUND 1 OF 3"
        a1={{
          tag: "A1",
          target: "3 × 8 @ 225.25 lb · REST 1:20",
          editor: { ...editorProps(a1Entry, a1Draft), unit: "lb", lastPerformance: "Last time · 220 lb × 8" },
        }}
        a2={{
          tag: "A2",
          target: "3 × 10 @ 50 kg · REST 1:20",
          editor: { ...editorProps(a2Entry, { entryKg: 50, reps: 10, setType: "working", rpe: null }), lastPerformance: "Last time · 48 kg × 10" },
        }}
        onLogRound={vi.fn()}
        onLogA1Only={vi.fn()}
        onLogA2Only={vi.fn()}
      />,
    );

    const cards = container.querySelectorAll(".superset-member-card");
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain("3 × 8 @ 225.25 lb · REST 1:20");
    expect(cards[0]?.textContent).toContain("Last time · 220 lb × 8");
    expect(cards[0]?.textContent).toContain("225.25");
    expect(cards[1]?.textContent).toContain("3 × 10 @ 50 kg · REST 1:20");
    expect(cards[1]?.textContent).toContain("Last time · 48 kg × 10");
    expect(cards[1]?.textContent).toContain("50");
  });

  it("labels partial recovery with the full member name and keeps it secondary", () => {
    const onLogA1Only = vi.fn();
    render(<Harness onLogRound={vi.fn()} onLogA1Only={onLogA1Only} />);

    const partial = screen.getByRole("button", { name: "Log Bench Press only" });
    expect(partial.className).toContain("btn-ghost");
    fireEvent.click(partial);

    expect(onLogA1Only).toHaveBeenCalledTimes(1);
    // The round no longer spells out A2's remaining state in a sentence —
    // it stays visible as its own compact block rather than disappearing as
    // if the round were already over.
    expect(screen.getByLabelText("A2 Barbell Row")).toBeTruthy();
  });

  it("offers only A2 when A1 has already been persisted", () => {
    const onLogA2Only = vi.fn();
    render(
      <Harness
        onLogRound={vi.fn()}
        onLogA1Only={vi.fn()}
        onLogA2Only={onLogA2Only}
        pendingMember="a2"
      />,
    );

    expect(screen.queryByRole("button", { name: "Log round" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Log Barbell Row only" }));
    expect(onLogA2Only).toHaveBeenCalledTimes(1);
  });

  it("names each-hand input and its stored total for a paired member", () => {
    const a1Draft: SetDraft = {
      entryKg: 40,
      reps: 8,
      setType: "working",
      rpe: null,
    };
    render(
      <SupersetRoundEditor
        label="SUPERSET A · ROUND 1 OF 3"
        a1={{
          tag: "A1",
          editor: {
            ...editorProps(a1Entry, a1Draft),
            loadPresentation: {
              ...editorProps(a1Entry, a1Draft).loadPresentation,
              perSide: true,
              totalKg: 80,
            },
          },
        }}
        a2={{
          tag: "A2",
          editor: editorProps(a2Entry, {
            entryKg: 50,
            reps: 10,
            setType: "working",
            rpe: null,
          }),
        }}
        onLogRound={vi.fn()}
        onLogA1Only={vi.fn()}
        onLogA2Only={vi.fn()}
      />,
    );

    expect(screen.getByText("EACH HAND × 2 · 80 KG TOTAL")).toBeTruthy();
  });
});
