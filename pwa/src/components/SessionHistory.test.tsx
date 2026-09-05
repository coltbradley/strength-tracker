// @vitest-environment jsdom
// The sections as a person meets them. The arithmetic is unit-tested next
// door in lib/sessionHistory.test.ts; what matters here is that a day opens
// to the sets that actually happened, that a session with no plan behind it
// still has a name, and that the two empty states read as sentences rather
// than as an empty table.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionList, WeekLine } from "./SessionHistory";
import type { SessionLogEntry, WeeklySummaryRow } from "../lib/sessionHistory";
import type { SetInsert } from "../lib/types";

afterEach(cleanup);

const entry = (over: Partial<SessionLogEntry>): SessionLogEntry => ({
  id: "s1",
  started_at: "2026-09-01T17:00:00.000Z",
  ended_at: "2026-09-01T18:12:00.000Z",
  session_rpe: 7,
  label: "Lower A",
  setCount: 14,
  ...over,
});

const set = (over: Partial<SetInsert>): SetInsert => ({
  id: "x1",
  session_id: "s1",
  exercise_id: "squat",
  prescription_id: null,
  set_index: 0,
  set_type: "working",
  load_kg: 100,
  reps: 5,
  performed_at: "2026-09-01T17:05:00.000Z",
  rest_seconds_actual: null,
  ...over,
});

const names: Record<string, string> = {
  squat: "Back Squat",
  press: "Overhead Press",
};
const exerciseName = (id: string) => names[id] ?? id;

function list(props: Partial<Parameters<typeof SessionList>[0]> = {}) {
  const onToggle = vi.fn();
  render(
    <SessionList
      sessions={[entry({})]}
      loading={false}
      unit="kg"
      openId={null}
      onToggle={onToggle}
      openSets={undefined}
      exerciseName={exerciseName}
      {...props}
    />,
  );
  return onToggle;
}

describe("the session log", () => {
  it("says what the day was, how long it took and how much was done", () => {
    list();
    expect(screen.getByText("Lower A")).toBeTruthy();
    expect(screen.getByText(/1H 12M/)).toBeTruthy();
    expect(screen.getByText(/14 SETS/)).toBeTruthy();
    expect(screen.getByText(/sRPE 7/)).toBeTruthy();
  });

  it("names an unplanned session rather than leaving a blank line", () => {
    list({ sessions: [entry({ label: null })] });
    expect(screen.getByText("Unplanned session")).toBeTruthy();
  });

  it("omits sRPE when none was given, instead of printing a placeholder", () => {
    list({ sessions: [entry({ session_rpe: null })] });
    expect(screen.queryByText(/sRPE/)).toBeNull();
  });

  it("counts one set in the singular", () => {
    list({ sessions: [entry({ setCount: 1 })] });
    expect(screen.getByText(/1 SET\b/)).toBeTruthy();
  });

  it("opens the day on a tap", () => {
    const onToggle = list();
    const row = screen.getByRole("button");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledWith("s1");
  });

  it("shows the open day's sets, grouped by movement, in the order they happened", () => {
    list({
      openId: "s1",
      openSets: [
        set({ id: "a", exercise_id: "squat", set_index: 0 }),
        set({ id: "b", exercise_id: "squat", set_index: 1, reps: 4 }),
        set({ id: "c", exercise_id: "press", set_index: 0, load_kg: 40 }),
      ],
    });
    expect(screen.getByText("Back Squat")).toBeTruthy();
    expect(screen.getByText("Overhead Press")).toBeTruthy();
    // SetRow renders the load as it was entered; load_kg is the total
    expect(screen.getByText(/40 kg × 5/)).toBeTruthy();
  });

  it("distinguishes 'still reading' from 'no sets'", () => {
    const { unmount } = render(
      <SessionList
        sessions={[entry({})]}
        loading={false}
        unit="kg"
        openId="s1"
        onToggle={vi.fn()}
        openSets={undefined}
        exerciseName={exerciseName}
      />,
    );
    expect(screen.getByText("Loading…")).toBeTruthy();
    unmount();
    list({ openId: "s1", openSets: [] });
    expect(screen.getByText("No sets left in this session.")).toBeTruthy();
  });

  it("says nothing has finished yet rather than drawing an empty table", () => {
    list({ sessions: [], loading: false });
    expect(screen.getByText("No finished sessions yet.")).toBeTruthy();
  });

  it("does not call an unloaded log empty", () => {
    list({ sessions: [], loading: true });
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("No finished sessions yet.")).toBeNull();
  });
});

const week = (over: Partial<WeeklySummaryRow>): WeeklySummaryRow => ({
  week_start: "2026-08-31",
  sessions: 0,
  working_sets: 0,
  tonnage_kg: 0,
  avg_session_rpe: null,
  planned_days: 0,
  planned_days_done: 0,
  ...over,
});

describe("the weekly line", () => {
  it("reads as one line of counts", () => {
    render(
      <WeekLine
        row={week({ sessions: 3, working_sets: 42, tonnage_kg: 12400 })}
        unit="kg"
        loading={false}
      />,
    );
    expect(
      screen.getByText("3 SESSIONS · 42 WORKING SETS · 12,400 KG"),
    ).toBeTruthy();
  });

  it("a week with a plan and no training still shows the plan", () => {
    render(
      <WeekLine
        row={week({ planned_days: 4, planned_days_done: 0 })}
        unit="kg"
        loading={false}
      />,
    );
    expect(screen.getByText("Nothing logged yet.")).toBeTruthy();
    expect(screen.getByText("4 PLANNED · 0 DONE")).toBeTruthy();
  });

  it("a week with training and no plan shows no adherence at all", () => {
    render(
      <WeekLine
        row={week({ sessions: 2, working_sets: 30, tonnage_kg: 8000 })}
        unit="kg"
        loading={false}
      />,
    );
    expect(screen.queryByText(/PLANNED/)).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("an untouched week is a sentence, not a row of zeroes", () => {
    render(<WeekLine row={null} unit="kg" loading={false} />);
    expect(
      screen.getByText("Nothing this week yet — no sessions, no plan."),
    ).toBeTruthy();
    expect(screen.queryByText(/0 SESSIONS/)).toBeNull();
  });
});
