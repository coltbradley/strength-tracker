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

async function open(props: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const view = render(
    <CheckInSheet
      userId="u1"
      localDate="2026-09-07"
      onClose={onClose}
      {...props}
    />,
  );
  await waitFor(() => screen.getByText("Fatigue"));
  return { onClose, view };
}

const writes = (table: string) =>
  enqueue.mock.calls.map((c) => c[0]).filter((op) => op.table === table);

describe("CheckInSheet", () => {
  // Three taps, no keyboard, nothing to scroll. It was eight items; a panel
  // that takes a minute gets answered for a fortnight, and this data is only
  // worth anything if it accrues for months.
  it("asks three things and no more", async () => {
    await open();
    expect(screen.getByText("Sleep")).toBeTruthy();
    expect(screen.getByText("Fatigue")).toBeTruthy();
    expect(screen.getByText("Soreness")).toBeTruthy();
    expect(screen.queryByText("Stress")).toBeNull();
    expect(screen.queryByText("Mood")).toBeNull();
    expect(screen.queryByText("Resting HR")).toBeNull();
  });

  // Nothing to press means nothing to fail to press.
  it("offers no Save button at all", async () => {
    await open();
    expect(screen.queryByRole("button", { name: /^save/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^done$/i })).toBeTruthy();
  });

  it("writes nothing when it is opened and closed untouched", async () => {
    const { view } = await open();
    view.unmount();
    expect(writes("daily_readiness")).toEqual([]);
  });

  // Closing IS saving. Walking away must not cost the answer.
  it("keeps what was answered when the sheet just closes", async () => {
    const { view } = await open();
    fireEvent.click(screen.getByRole("button", { name: "Fatigue 4 of 5" }));
    view.unmount();
    await waitFor(() => expect(writes("daily_readiness").length).toBe(1));
    const p = writes("daily_readiness")[0].payload;
    expect(p.fatigue).toBe(4);
    // An unanswered question must not arrive as a zero: null is unknown and
    // zero is a measurement.
    expect("soreness" in p).toBe(false);
  });

  it("clears a value when the chosen one is tapped again", async () => {
    const { view } = await open();
    const four = screen.getByRole("button", { name: "Fatigue 4 of 5" });
    fireEvent.click(four);
    expect(four.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(four);
    expect(four.getAttribute("aria-pressed")).toBe("false");
    view.unmount();
    await waitFor(() => expect(writes("daily_readiness").length).toBe(1));
    // Cleared explicitly, which is a different fact from never answered.
    expect(writes("daily_readiness")[0].payload.fatigue).toBeNull();
  });

  // "Not today" has to leave a trace or the button is decoration: duePrompts
  // honours a recorded skip and stops asking for the day.
  it("records a skip and closes, without writing a panel", async () => {
    const onSkipped = vi.fn();
    const { onClose } = await open({ onSkipped });
    fireEvent.click(screen.getByRole("button", { name: /not today/i }));
    await waitFor(() => expect(writes("report_prompts").length).toBe(1));
    const p = writes("report_prompts")[0].payload;
    expect(p).toMatchObject({
      kind: "daily_readiness",
      channel: "in_app",
      skipped: true,
    });
    expect(writes("daily_readiness")).toEqual([]);
    expect(onSkipped).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the rest one tap away rather than gone", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: /anything else/i }));
    expect(screen.getByText("Stress")).toBeTruthy();
    expect(screen.getByText("Mood")).toBeTruthy();
    expect(screen.getByText("Sleep (hours)")).toBeTruthy();
    expect(screen.getByText("Resting HR")).toBeTruthy();
  });

  it("reuses today's row id so a correction merges instead of colliding", async () => {
    getReadinessFor.mockResolvedValue({
      id: "existing-row",
      local_date: "2026-09-07",
      recorded_at: "2026-09-07T07:00:00.000Z",
      fatigue: 3,
    });
    const { view } = await open();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Fatigue 3 of 5" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Fatigue 5 of 5" }));
    view.unmount();
    await waitFor(() => expect(writes("daily_readiness").length).toBe(1));
    expect(writes("daily_readiness")[0].payload.id).toBe("existing-row");
    expect(writes("daily_readiness")[0].payload.fatigue).toBe(5);
  });
});
