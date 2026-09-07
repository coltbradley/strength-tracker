// @vitest-environment jsdom
// The panel as a person actually meets it.
//
// The behaviour worth pinning is that SKIPPING IS FINE. A panel somebody must
// complete is a panel somebody stops opening, and this data is only worth
// anything if it accrues every day. So: the sheet saves with nothing answered,
// a chosen value can be un-chosen, and an unanswered question never reaches the
// database as a zero.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// vi.hoisted, because vi.mock factories are lifted above every const in the
// file and would otherwise close over an uninitialised binding.
const { enqueue, getReadinessFor } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  getReadinessFor: vi.fn(),
}));
vi.mock("../lib/sync", () => ({ outbox: { enqueue } }));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast: vi.fn() }));
// Stubbed so importing the sheet does not drag in a Supabase client; the pure
// helpers are re-exported from the real module because THEY are what is under
// test here (what reaches the payload), not the network read.
vi.mock("../lib/supabase", () => ({ supabase: {} }));
vi.mock("../lib/data", () => ({ throwIf: vi.fn() }));
vi.mock("../lib/checkins", async () => {
  const actual = await vi.importActual<typeof import("../lib/checkins")>(
    "../lib/checkins",
  );
  return { ...actual, getReadinessFor };
});

import { CheckInSheet } from "./CheckInSheet";

afterEach(cleanup);
beforeEach(() => {
  enqueue.mockReset();
  enqueue.mockResolvedValue(undefined);
  getReadinessFor.mockReset();
  getReadinessFor.mockResolvedValue(null);
});

async function open(onClose = vi.fn()) {
  render(
    <CheckInSheet userId="u1" localDate="2026-09-07" onClose={onClose} />,
  );
  await waitFor(() => screen.getByText("Sleep"));
  return { onClose };
}

const payload = () => enqueue.mock.calls[0][0].payload;

describe("CheckInSheet", () => {
  it("offers to save even with nothing answered, and says so", async () => {
    await open();
    const save = screen.getByRole("button", {
      name: /save \(nothing today\)/i,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("writes no items at all for an untouched panel", async () => {
    const { onClose } = await open();
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    const p = payload();
    // The load-bearing assertion: an unanswered question must not arrive as 0.
    expect("fatigue" in p).toBe(false);
    expect("sleep_hours" in p).toBe(false);
    expect(p).toMatchObject({ user_id: "u1", local_date: "2026-09-07" });
    expect(onClose).toHaveBeenCalled();
  });

  it("records only the items that were answered", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Fatigue 4 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    const p = payload();
    expect(p.fatigue).toBe(4);
    expect("mood" in p).toBe(false);
  });

  // Without this there is no way back from a mis-tap except closing the sheet,
  // and a question you cannot un-answer is one people answer carelessly.
  it("clears a value when the chosen one is tapped again", async () => {
    await open();
    const four = screen.getByRole("button", { name: "Fatigue 4 of 5" });
    fireEvent.click(four);
    expect(four.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(four);
    expect(four.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /save \(nothing today\)/i }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    // Cleared explicitly, which is different from never answered: the column
    // is set to null so a correction removes an earlier answer.
    expect(payload().fatigue).toBeNull();
  });

  it("reuses today's row id so a correction merges instead of colliding", async () => {
    getReadinessFor.mockResolvedValue({
      id: "existing-row",
      local_date: "2026-09-07",
      recorded_at: "2026-09-07T07:00:00.000Z",
      mood: 3,
    });
    render(
      <CheckInSheet userId="u1" localDate="2026-09-07" onClose={vi.fn()} />,
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Mood 3 of 5" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Mood 5 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(enqueue).toHaveBeenCalled());
    expect(payload().id).toBe("existing-row");
    expect(payload().mood).toBe(5);
  });

  it("keeps the extra context behind a disclosure, not in the main panel", async () => {
    await open();
    expect(screen.queryByText("Resting HR")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /anything else/i }));
    expect(screen.getByText("Resting HR")).toBeTruthy();
  });
});
