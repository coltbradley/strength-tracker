// @vitest-environment jsdom
//
// The bodyweight row on Today.
//
// Two things carry real risk here and both are about telling the truth with a
// number. The row must read the UNION view, so a lifter who has only ever
// weighed in before training still sees their figure rather than a blank; and
// what it stores must survive the round trip through pounds, because someone
// who types 180 and watches it come back 179.9 will not type it again.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const getBodyweight = vi.fn();
const recordBodyweight = vi.fn();

vi.mock("../lib/data", () => ({
  getBodyweight: () => getBodyweight(),
  recordBodyweight: (...a: unknown[]) => recordBodyweight(...a),
}));
vi.mock("../lib/errors", () => ({ reportError: vi.fn() }));

// Only the unit hook is mocked. `settings` is left REAL because the Stepper
// reads its increments through it, and a partial mock of that module gives the
// stepper an undefined step rather than a failing import — a bug that would
// look like a rendering problem.
let unit: "kg" | "lb" = "kg";
vi.mock("../hooks/useUnit", () => ({ useUnit: () => unit }));

import { BodyweightRow, agoLabel } from "./BodyweightRow";

const point = (over: Record<string, unknown> = {}) => ({
  measured_at: new Date().toISOString(),
  weight_kg: 77.1,
  source: "log" as const,
  ...over,
});

afterEach(cleanup);

beforeEach(() => {
  unit = "kg";
  vi.clearAllMocks();
  getBodyweight.mockResolvedValue({ data: [point()], fromCache: false });
  recordBodyweight.mockImplementation((kg: number) =>
    Promise.resolve(point({ weight_kg: kg })),
  );
});

describe("agoLabel", () => {
  const now = new Date(2026, 8, 6, 9, 0); // 2026-09-06 09:00 local

  it("counts CALENDAR days, not 24-hour blocks", () => {
    // 07:00 yesterday read at 09:00 today is 26 hours and also "yesterday".
    // The row's whole job is to say whether TODAY's is done.
    expect(agoLabel(new Date(2026, 8, 6, 7, 0).toISOString(), now)).toBe(
      "today",
    );
    expect(agoLabel(new Date(2026, 8, 5, 7, 0).toISOString(), now)).toBe(
      "yesterday",
    );
    expect(agoLabel(new Date(2026, 8, 2, 7, 0).toISOString(), now)).toBe(
      "4 days ago",
    );
    expect(agoLabel(new Date(2026, 7, 30, 7, 0).toISOString(), now)).toBe(
      "last week",
    );
    expect(agoLabel(new Date(2026, 7, 16, 7, 0).toISOString(), now)).toBe(
      "3 weeks ago",
    );
  });
});

describe("BodyweightRow", () => {
  it("shows the latest figure and offers to update it when it is today's", async () => {
    render(<BodyweightRow />);
    expect(await screen.findByText(/77.1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("asks for a weigh-in when the last one is not today's", async () => {
    getBodyweight.mockResolvedValue({
      data: [
        point({
          measured_at: new Date(Date.now() - 3 * 86400000).toISOString(),
        }),
      ],
      fromCache: false,
    });
    render(<BodyweightRow />);
    expect(
      await screen.findByRole("button", { name: "Weigh in" }),
    ).toBeTruthy();
  });

  it("says so plainly when there is nothing recorded yet", async () => {
    getBodyweight.mockResolvedValue({ data: [], fromCache: false });
    render(<BodyweightRow />);
    expect(await screen.findByText("No weigh-ins yet")).toBeTruthy();
  });

  it("marks a figure that came from a session, because that is a different fact", async () => {
    // v_bodyweight unions the standalone log with the per-session weigh-in.
    // A row that hid the difference would answer "when did you last weigh in"
    // with a number taken on a day the lifter only remembers as training.
    getBodyweight.mockResolvedValue({
      data: [point({ source: "session" })],
      fromCache: false,
    });
    render(<BodyweightRow />);
    expect(await screen.findByText(/before training/)).toBeTruthy();
  });

  it("records what was typed, in kg, at two decimals", async () => {
    render(<BodyweightRow />);
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(recordBodyweight).toHaveBeenCalled());
    // Opened on the last known figure, so saving without touching it is a
    // confirmation of that number rather than a jump to a default.
    expect(recordBodyweight).toHaveBeenCalledWith(77.1);
  });

  it("renders the written figure without waiting for a refetch", async () => {
    // The refetch is exactly what cannot run on a phone with no signal, and
    // someone who has just weighed in has to see the row say so today.
    getBodyweight.mockResolvedValue({ data: [], fromCache: false });
    render(<BodyweightRow />);
    fireEvent.click(await screen.findByRole("button", { name: "Weigh in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByText("No weigh-ins yet")).toBeNull(),
    );
    expect(getBodyweight).toHaveBeenCalledTimes(1);
  });

  it("Cancel writes nothing", async () => {
    render(<BodyweightRow />);
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Update" });
    expect(recordBodyweight).not.toHaveBeenCalled();
  });

  it("a failed load still offers to record one", async () => {
    // Offline on a new device: the row cannot say what the last figure was,
    // but refusing to take today's would be the wrong half to give up.
    getBodyweight.mockRejectedValue(new Error("offline"));
    render(<BodyweightRow />);
    expect(
      await screen.findByRole("button", { name: "Weigh in" }),
    ).toBeTruthy();
  });
});
