// @vitest-environment jsdom
// A logged row is the record of what was lifted. `load_kg` is always the
// TOTAL, so the one thing this component must never do is read a per-side set
// back as the doubled number the column holds.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetRow } from "./SetRow";
import type { LoadEntry, SetInsert } from "../lib/types";

afterEach(cleanup);

function set(load_kg: number, load_entry?: LoadEntry | null): SetInsert {
  return {
    id: "s1",
    session_id: "sess",
    exercise_id: "Dumbbell_Bench_Press",
    prescription_id: null,
    set_index: 0,
    set_type: "working",
    load_kg,
    reps: 8,
    performed_at: "2026-08-27T10:00:00.000Z",
    rest_seconds_actual: null,
    load_entry,
  };
}

describe("SetRow", () => {
  it("shows a per-side set the way it was entered", () => {
    render(<SetRow set={set(60, "per_side")} unit="kg" />);
    expect(screen.getByText(/30 kg\/side × 8/)).toBeTruthy();
    expect(screen.queryByText(/60/)).toBeNull();
  });

  it("shows a total set as the whole system", () => {
    render(<SetRow set={set(100, "total")} unit="kg" />);
    expect(screen.getByText(/100 kg × 8/)).toBeTruthy();
  });

  it("renders an unasserted (legacy) set plainly, with no per-side claim", () => {
    render(<SetRow set={set(30, null)} unit="kg" />);
    expect(screen.getByText(/30 kg × 8/)).toBeTruthy();
  });

  it("converts the per-side value, not the total, into lb", () => {
    render(<SetRow set={set(40, "per_side")} unit="lb" />);
    expect(screen.getByText(/44\.1 lb\/side × 8/)).toBeTruthy();
  });

  it("has no correction control unless one is offered (History)", () => {
    render(<SetRow set={set(100, "total")} unit="kg" />);
    expect(screen.queryByRole("button", { name: /correct set/ })).toBeNull();
  });

  it("makes the numbers the tap target for a correction", () => {
    const onEdit = vi.fn();
    render(<SetRow set={set(100, "total")} unit="kg" onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "correct set 1" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("says which set is being corrected", () => {
    const { container } = render(
      <SetRow set={set(100, "total")} unit="kg" onEdit={() => {}} editing />,
    );
    expect(container.querySelector(".logged-set-editing")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "correct set 1" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
