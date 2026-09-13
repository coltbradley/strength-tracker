// @vitest-environment jsdom
// The check-in sheet as a person actually meets it.
//
// Two things live in here now, and they are tested separately because they
// save differently. The SPONTANEOUS check-in (text + mood chips + optional
// energy) is a single explicit "Check in" action that writes one `checkins`
// row. The morning readiness scales are unchanged from before this rebuild —
// still autosave-as-you-go, still skippable, still merge onto today's row —
// just moved behind a collapsed disclosure so the sheet leads with the thing
// that is always worth doing rather than the thing that is worth doing once
// a day.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// vi.hoisted, because vi.mock factories are lifted above every const in the
// file and would otherwise close over an uninitialised binding.
const { enqueue, getReadinessFor, toast } = vi.hoisted(() => ({
  enqueue: vi.fn(),
  getReadinessFor: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("../lib/sync", () => ({ outbox: { enqueue } }));
vi.mock("../lib/errors", () => ({ reportError: vi.fn(), toast }));
// Stubbed so importing the sheet does not drag in a Supabase client; the pure
// helpers are re-exported from the real module because THEY are what is under
// test here (what reaches the payload), not the network read.
vi.mock("../lib/supabase", () => ({ supabase: {} }));
vi.mock("../lib/data", () => ({ throwIf: vi.fn() }));
vi.mock("../lib/checkins", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/checkins")>("../lib/checkins");
  return { ...actual, getReadinessFor };
});

import { CheckInSheet } from "./CheckInSheet";

afterEach(cleanup);
beforeEach(() => {
  enqueue.mockReset();
  enqueue.mockResolvedValue(undefined);
  getReadinessFor.mockReset();
  getReadinessFor.mockResolvedValue(null);
  toast.mockReset();
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
  await waitFor(() => screen.getByLabelText("How are you feeling?"));
  return { onClose, view };
}

const writes = (table: string) =>
  enqueue.mock.calls.map((c) => c[0]).filter((op) => op.table === table);

function box(): HTMLTextAreaElement {
  return screen.getByLabelText("How are you feeling?") as HTMLTextAreaElement;
}

describe("CheckInSheet: spontaneous check-in", () => {
  it("opens with an empty box, no chip on, and Check in disabled", () => {
    return open().then(() => {
      expect(box().value).toBe("");
      expect(
        screen.getByRole("button", { name: /^check in$/i }),
      ).toHaveProperty("disabled", true);
    });
  });

  it("offers the five mood words", async () => {
    await open();
    for (const word of ["Sore", "Hurt", "Tired", "Stressed", "Great"]) {
      expect(screen.getByRole("button", { name: word })).toBeTruthy();
    }
  });

  it("typing enables Check in", async () => {
    await open();
    fireEvent.change(box(), { target: { value: "legs are wrecked" } });
    expect(screen.getByRole("button", { name: /^check in$/i })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("tapping a chip appends its word to the box and enables Check in", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Sore" }));
    expect(box().value).toBe("Sore");
    expect(
      screen.getByRole("button", { name: "Sore" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: /^check in$/i })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("tapping the same chip again removes it", async () => {
    await open();
    const chip = screen.getByRole("button", { name: "Tired" });
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(box().value).toBe("");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /^check in$/i })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("multiple chips accumulate in the box", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Sore" }));
    fireEvent.click(screen.getByRole("button", { name: "Great" }));
    expect(box().value).toBe("Sore, Great");
  });

  it("an energy pick alone enables Check in, and taps again to clear", async () => {
    await open();
    const three = screen.getByRole("button", { name: "Energy 3 of 5" });
    fireEvent.click(three);
    expect(three.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^check in$/i })).toHaveProperty(
      "disabled",
      false,
    );
    fireEvent.click(three);
    expect(three.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /^check in$/i })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("saves a spontaneous checkins row with the note and energy, then closes", async () => {
    const { onClose } = await open();
    fireEvent.change(box(), { target: { value: "shoulder is cranky" } });
    fireEvent.click(screen.getByRole("button", { name: "Energy 4 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: /^check in$/i }));
    await waitFor(() => expect(writes("checkins").length).toBe(1));
    const p = writes("checkins")[0].payload;
    expect(p).toMatchObject({
      user_id: "u1",
      kind: "spontaneous",
      note: "shoulder is cranky",
      energy: 4,
    });
    expect(typeof p.id).toBe("string");
    expect(p.id.length).toBeGreaterThan(0);
    expect(onClose).toHaveBeenCalled();
    expect(toast).toHaveBeenCalled();
  });

  it("never writes a checkins row for an untouched sheet", async () => {
    const { view } = await open();
    view.unmount();
    expect(writes("checkins")).toEqual([]);
  });
});

describe("CheckInSheet: readiness disclosure (unchanged behaviour)", () => {
  async function openReadiness(props: Record<string, unknown> = {}) {
    const opened = await open(props);
    fireEvent.click(
      screen.getByRole("button", { name: /sleep, fatigue, soreness/i }),
    );
    await waitFor(() => screen.getByText("Fatigue"));
    return opened;
  }

  it("is collapsed by default", async () => {
    await open();
    expect(screen.queryByText("Fatigue")).toBeNull();
  });

  it("asks three things and no more once opened", async () => {
    await openReadiness();
    expect(screen.getByText("Sleep")).toBeTruthy();
    expect(screen.getByText("Fatigue")).toBeTruthy();
    expect(screen.getByText("Soreness")).toBeTruthy();
    expect(screen.queryByText("Stress")).toBeNull();
    expect(screen.queryByText("Mood")).toBeNull();
    expect(screen.queryByText("Resting HR")).toBeNull();
  });

  it("writes nothing when it is opened and closed untouched", async () => {
    const { view } = await openReadiness();
    view.unmount();
    expect(writes("daily_readiness")).toEqual([]);
  });

  // Closing IS saving. Walking away must not cost the answer.
  it("keeps what was answered when the sheet just closes", async () => {
    const { view } = await openReadiness();
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
    const { view } = await openReadiness();
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

  it("records a skip without writing a panel", async () => {
    const onSkipped = vi.fn();
    const { onClose } = await openReadiness({ onSkipped });
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
    await openReadiness();
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
    const { view } = await openReadiness();
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
